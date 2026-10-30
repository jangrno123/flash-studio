'use strict';
// SKILL.md(프런트매터 + 본문) 형식의 스킬 로더. Claude 스킬 폴더와 호환된다.
const fs = require('fs');
const path = require('path');

function parseFrontmatter(text) {
  const src = text.replace(/^﻿/, '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, val] = kv;
    if (/^[>|][+-]?$/.test(val)) {
      const folded = val.startsWith('>');
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      val = block.join(folded ? ' ' : '\n').trim();
    } else if (/^(["']).*\1$/.test(val)) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

function listFiles(dir, base = dir, out = [], depth = 0) {
  if (depth > 4 || out.length > 200) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '__pycache__') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(full, base, out, depth + 1);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

class SkillLibrary {
  constructor(localDir, registry, backupDir = path.join(path.dirname(localDir), 'skill-revisions')) {
    this.localDir = localDir;
    this.reg = registry;
    this.skills = new Map();
    this.backupDir = backupDir;
    this.unavailableDirs = [];
  }

  scan(extraDirs = [], disabled = []) {
    const off = new Set(disabled);
    const found = new Map();
    this.unavailableDirs = [];
    const dirs = [{ dir: this.localDir, source: 'local' }, ...extraDirs.map((d) => ({ dir: d, source: 'external' }))];
    for (const { dir, source } of dirs) {
      if (!dir || !fs.existsSync(dir)) { if (dir) this.unavailableDirs.push(dir); continue; }
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { this.unavailableDirs.push(dir); continue; }
      // 폴더 자체가 스킬이거나(SKILL.md 존재), 하위 폴더들이 스킬
      const candidates = fs.existsSync(path.join(dir, 'SKILL.md')) ? [dir] : entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
      for (const sd of candidates) {
        const file = path.join(sd, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        try {
          const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
          const skill = {
            name: String(meta.name || path.basename(sd)).trim().slice(0, 80),
            description: String(meta.description || '').slice(0, 8000),
            source,
            dir: sd,
            files: listFiles(sd).filter((f) => f !== 'SKILL.md')
          };
          const r = this.reg.validate('skill.schema.json', skill);
          if (!r.valid) { console.warn(`[skills] ${sd} 건너뜀: ${r.errors[0]}`); continue; }
          if (!found.has(skill.name) && !off.has(skill.name)) found.set(skill.name, skill);
        } catch (e) { console.warn(`[skills] ${sd} 읽기 실패: ${e.message}`); }
      }
    }
    this.skills = found;
    return this.list();
  }

  list() { return [...this.skills.values()].map(({ name, description, source, files, dir }) => ({ name, description, source, files, dir })); }

  get(name) { return this.skills.get(name) || null; }

  read(name) {
    const s = this.get(name);
    if (!s) throw new Error(`스킬을 찾을 수 없습니다: ${name}`);
    const text = this.readFile(name, 'SKILL.md');
    return { ...s, raw: text, body: parseFrontmatter(text).body };
  }

  readFile(name, rel) {
    const full = this.filePath(name, rel);
    if (!fs.existsSync(full)) throw new Error(`파일 없음: ${rel}`);
    return fs.readFileSync(full, 'utf8');
  }

  filePath(name, rel) {
    const s = this.get(name);
    if (!s) throw new Error(`스킬을 찾을 수 없습니다: ${name}`);
    if (!rel || path.isAbsolute(rel)) throw new Error('스킬 기준 상대 경로를 입력하세요');
    const root = fs.realpathSync(s.dir), full = path.resolve(root, rel);
    const inside = value => value.toLowerCase().startsWith(root.toLowerCase() + path.sep);
    if (!inside(full)) throw new Error('스킬 폴더 밖의 파일에는 접근할 수 없습니다');
    let parent = full;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const actual = fs.realpathSync(parent);
    if (actual.toLowerCase() !== root.toLowerCase() && !inside(actual)) throw new Error('스킬 밖을 가리키는 링크에는 접근할 수 없습니다');
    return full;
  }

  writeFile(name, rel, content, expectedContent) {
    if (typeof content !== 'string' || content.length > 500000) throw new Error('스킬 텍스트는 500000자 이내로 입력하세요');
    const full = this.filePath(name, rel);
    const previous = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (previous !== null && expectedContent === undefined) throw new Error('기존 파일은 먼저 읽고 expected_content로 원문을 지정하세요');
    if (expectedContent !== undefined && previous !== expectedContent) throw new Error('스킬 파일이 변경됐습니다. 최신 원문을 읽은 뒤 수정하세요');
    if (path.basename(full).toLowerCase() === 'skill.md') {
      const parsed = parseFrontmatter(content);
      if (parsed.meta.name !== name || !String(parsed.meta.description || '').trim() || !parsed.body.trim()) throw new Error('SKILL.md의 기존 name, description과 본문을 유지하세요');
    }
    if (previous === content) return { path: full, changed: false, backup: null };
    let backup = null;
    if (previous !== null) {
      const folder = path.join(this.backupDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + require('crypto').randomUUID());
      fs.mkdirSync(folder, { recursive: true });
      backup = path.join(folder, path.basename(full));
      fs.writeFileSync(backup, previous, 'utf8');
      fs.writeFileSync(path.join(folder, 'source.json'), JSON.stringify({ name, path: full, createdAt: new Date().toISOString() }), 'utf8');
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { path: full, changed: true, backup };
  }

  editFile(name, rel, oldText, newText) {
    const previous = this.readFile(name, rel);
    if (!oldText || !previous.includes(oldText)) throw new Error('수정할 원문이 없습니다. 파일을 다시 읽으세요');
    if (previous.indexOf(oldText) !== previous.lastIndexOf(oldText)) throw new Error('수정할 원문이 여러 번 나옵니다. 문맥을 포함해서 지정하세요');
    return this.writeFile(name, rel, previous.replace(oldText, () => newText), previous);
  }

  create({ name, description, body }) {
    this.reg.assert('skill.schema.json#/$defs/createRequest', { name, description, body });
    const dir = path.join(this.localDir, name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('이미 등록된 스킬입니다. edit_skill_file로 기존 내용을 수정하세요');
    fs.mkdirSync(dir, { recursive: true });
    const desc = description.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${body.trim()}\n`, 'utf8');
  }

  remove(name) {
    const s = this.get(name);
    if (!s) throw new Error(`스킬을 찾을 수 없습니다: ${name}`);
    if (s.source !== 'local') throw new Error('외부 폴더의 스킬은 여기서 삭제할 수 없습니다');
    fs.rmSync(s.dir, { recursive: true, force: true });
    this.skills.delete(name);
  }
}

module.exports = { SkillLibrary, parseFrontmatter };
