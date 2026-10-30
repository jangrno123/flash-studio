'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { redact, validateSummary, SECTIONS } = require('./handoff');

const VERSION = 1;
const HASH_BINDING = 'flash-handoff-draft-sha256-v1';
const SUMMARY_LIMIT = 70000;
const PACKET_LIMIT = 80000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

// Keys are sorted so equivalent base inputs have the same hash. The caller supplies
// stable original instructions/handoff/skills, excluding transient compaction.
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Checkpoint input must be finite, acyclic JSON data.');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new TypeError('Checkpoint input must be plain JSON data.');
  seen.add(value);
  let encoded;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index))) throw new TypeError('Checkpoint input must not contain sparse arrays.');
    encoded = `[${value.map(item => canonical(item, seen)).join(',')}]`;
  } else {
    encoded = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return encoded;
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function checkedSummary(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > SUMMARY_LIMIT) throw new Error('Checkpoint summary is empty or exceeds 70,000 characters.');
  const summary = redact(value);
  validateSummary(summary);
  return summary;
}

function checkedPacket(value) {
  if (!exactKeys(value, ['summary', 'files']) || typeof value.summary !== 'string'
    || !value.summary.trim() || value.summary.length > PACKET_LIMIT || !Array.isArray(value.files)) throw new Error('Invalid final handoff packet.');
  const summary = redact(value.summary);
  if (SECTIONS.some(section => !summary.includes(`## ${section}`))) throw new Error('Final handoff packet is missing required sections.');
  const files = value.files.map(file => {
    if (!exactKeys(file, ['label', 'ref']) || typeof file.label !== 'string' || typeof file.ref !== 'string' || !file.ref) throw new Error('Invalid final handoff file reference.');
    return { label: redact(file.label), ref: redact(file.ref) };
  });
  return { summary, files };
}

function prefixHashes(baseHash, chunkHashes) {
  let previous = hash([HASH_BINDING, 'base', baseHash]);
  return chunkHashes.map((chunkHash, index) => {
    previous = hash([HASH_BINDING, 'chunk', index, previous, chunkHash]);
    return previous;
  });
}

function seal(state) {
  return { ...state, integrityHash: hash(state) };
}

function validState(state, conversationId) {
  if (!exactKeys(state, ['version', 'hashBinding', 'conversationId', 'baseHash', 'chunkHashes', 'completed', 'summaries', 'packet', 'integrityHash'])) return false;
  if (state.version !== VERSION || state.hashBinding !== HASH_BINDING || state.conversationId !== conversationId
    || typeof state.baseHash !== 'string' || !HASH_PATTERN.test(state.baseHash) || !Array.isArray(state.chunkHashes)
    || state.chunkHashes.some(value => typeof value !== 'string' || !HASH_PATTERN.test(value))
    || !Number.isSafeInteger(state.completed) || state.completed < 0 || state.completed > state.chunkHashes.length
    || !Array.isArray(state.summaries) || state.summaries.length !== state.completed) return false;
  const { integrityHash, ...body } = state;
  if (typeof integrityHash !== 'string' || integrityHash !== hash(body)) return false;
  const prefixes = prefixHashes(state.baseHash, state.chunkHashes);
  for (const [index, entry] of state.summaries.entries()) {
    if (!exactKeys(entry, ['index', 'prefixHash', 'summaryHash', 'summary']) || entry.index !== index
      || entry.prefixHash !== prefixes[index] || entry.summaryHash !== hash(entry.summary)) return false;
    try { if (checkedSummary(entry.summary) !== entry.summary) return false; } catch { return false; }
  }
  if (state.packet !== null) {
    if (state.completed !== state.chunkHashes.length || !exactKeys(state.packet, ['prefixHash', 'packetHash', 'value'])) return false;
    try {
      const packet = checkedPacket(state.packet.value);
      if (state.packet.prefixHash !== (prefixes.at(-1) || hash([HASH_BINDING, 'base', state.baseHash]))
        || state.packet.packetHash !== hash(packet) || canonical(packet) !== canonical(state.packet.value)) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * Durable cumulative model summaries. Construct/read before a model call and
 * commit only after its complete output passes validation; never store a stream.
 * Original input text is represented only by hashes. Summary/file text is redacted.
 */
class HandoffCheckpoint {
  constructor({ directory, conversationId, baseInput, chunks }) {
    if (typeof directory !== 'string' || !directory || typeof conversationId !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) throw new TypeError('Checkpoint requires a directory and a safe conversation ID.');
    if (!Array.isArray(chunks) || Object.keys(chunks).length !== chunks.length
      || Array.from({ length: chunks.length }, (_, index) => index).some(index => !Object.hasOwn(chunks, index) || typeof chunks[index] !== 'string')) throw new TypeError('Checkpoint chunks must be an array of strings.');
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, `${conversationId}-draft-checkpoint.json`);
    this.baseHash = hash([HASH_BINDING, 'base-input', baseInput]);
    this.chunkHashes = chunks.map(chunk => hash([HASH_BINDING, 'transcript', chunk]));
    this.prefixHashes = prefixHashes(this.baseHash, this.chunkHashes);
    this.total = chunks.length;
    this.reused = 0;
    this.resetReason = null;
    this.state = { version: VERSION, hashBinding: HASH_BINDING, conversationId, baseHash: this.baseHash,
      chunkHashes: [...this.chunkHashes], completed: 0, summaries: [], packet: null };
    this.diskText = this.readDisk();
    if (this.diskText === null) return;
    let saved;
    try { saved = JSON.parse(this.diskText); if (!validState(saved, conversationId)) throw new Error('Invalid checkpoint state.'); }
    catch { this.resetReason = 'corrupt'; return; }
    if (saved.baseHash !== this.baseHash) { this.resetReason = 'base-input-changed'; return; }
    while (this.reused < saved.completed && this.reused < this.total
      && saved.chunkHashes[this.reused] === this.chunkHashes[this.reused]) this.reused++;
    this.state.completed = this.reused;
    this.state.summaries = saved.summaries.slice(0, this.reused);
    if (saved.packet && saved.chunkHashes.length === this.total && this.reused === this.total) this.state.packet = saved.packet;
    if (this.reused !== saved.completed) this.resetReason = 'transcript-changed';
  }

  readDisk() {
    try {
      if (!fs.lstatSync(this.file).isFile()) throw new Error('Checkpoint target must be a regular file.');
      return fs.readFileSync(this.file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  read() {
    const completed = this.state.completed;
    return { completed, summary: completed ? this.state.summaries[completed - 1].summary : '', total: this.total,
      remaining: this.total - completed, reused: this.reused, resetReason: this.resetReason,
      packet: this.state.packet ? JSON.parse(JSON.stringify(this.state.packet.value)) : null };
  }

  save(next) {
    // A stale caller cannot overwrite progress another draft writer committed.
    if (this.readDisk() !== this.diskText) throw new Error('Handoff checkpoint changed during draft generation; reload before committing.');
    fs.mkdirSync(this.directory, { recursive: true });
    const temp = path.join(this.directory, `${this.state.conversationId}-draft-checkpoint.${randomUUID()}.tmp`);
    const encoded = JSON.stringify(seal(next), null, 2) + '\n';
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, encoded, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      this.diskText = encoded;
      this.state = next;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  commit(index, validatedSummary) {
    if (!Number.isSafeInteger(index) || index !== this.state.completed || index >= this.total) throw new RangeError('Checkpoint commits must follow the next transcript chunk in order.');
    const summary = checkedSummary(validatedSummary);
    const entry = { index, prefixHash: this.prefixHashes[index], summaryHash: hash(summary), summary };
    this.save({ ...this.state, completed: index + 1, summaries: [...this.state.summaries, entry], packet: null });
    return this.read();
  }

  finish({ summary, files = [] }) {
    if (this.state.completed !== this.total) throw new Error('Cannot finish a handoff checkpoint before all chunks are complete.');
    const value = checkedPacket({ summary, files });
    this.save({ ...this.state, packet: { prefixHash: this.prefixHashes.at(-1) || hash([HASH_BINDING, 'base', this.baseHash]), packetHash: hash(value), value } });
    return this.read();
  }
}

module.exports = { HandoffCheckpoint, VERSION, HASH_BINDING, SUMMARY_LIMIT };
