'use strict';
// JSON 파일 저장소. 모든 읽기/쓰기는 스키마로 검증한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const now = () => new Date().toISOString();
const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/;

const DEFAULT_SYSTEM_PROMPT = [
  '당신은 사용자의 PC에 설치되어 동작하는 AI 어시스턴트입니다.',
  '사용자가 쓰는 언어로 답하고, 한국어 질문에는 자연스러운 한국어로 답하세요.',
  '확실하지 않은 내용은 추측하지 말고 모른다고 말하세요. 필요하면 도구를 적극적으로 쓰되, 도구 결과를 지어내지 마세요.',
  '코드와 명령어는 언어를 표시한 코드 블록으로 감싸세요.'
].join('\n');

function defaultProviders() {
  return [
    {
      id: 'modelark', name: 'BytePlus ModelArk', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      apiKey: '', apiKeyEnv: 'ARK_API_KEY', thinkingStyle: 'thinking_object',
      models: [
        { id: 'deepseek-v4-flash-ga-260731', label: 'DeepSeek V4 Flash', vision: false, tools: true, reasoning: true, contextWindow: 1048576 },
        { id: 'deepseek-v4-1-flash-260910', label: 'DeepSeek V4.1 Flash', vision: false, tools: true, reasoning: true, contextWindow: 1048576 },
        { id: 'deepseek-v4-pro-ga-260813', label: 'DeepSeek V4 Pro', vision: false, tools: true, reasoning: true, contextWindow: 1048576 },
        { id: 'seed-sc-260628', label: 'Seed SC', vision: false, tools: true, reasoning: false, contextWindow: 98304 },
        { id: 'dola-seed-2-1-turbo-260628', label: 'Seed 2.1 Turbo', vision: true, tools: true, reasoning: true, contextWindow: 262144 }
      ]
    },
    {
      id: 'volcengine', name: 'Volcengine Ark (중국)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: '', apiKeyEnv: 'ARK_API_KEY', thinkingStyle: 'thinking_object',
      models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', vision: false, tools: true, reasoning: true }]
    },
    {
      id: 'deepseek', name: 'DeepSeek 공식', baseUrl: 'https://api.deepseek.com',
      apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY', thinkingStyle: 'thinking_object',
      models: [
        { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash (1017)', vision: true, tools: true, reasoning: true, contextWindow: 1048576 },
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4.1 Flash (호환 별칭)', vision: true, tools: true, reasoning: true, contextWindow: 1048576 }
      ]
    },
    {
      id: 'ollama', name: 'Ollama (로컬)', baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '', apiKeyEnv: '', thinkingStyle: 'none',
      models: [{ id: 'deepseek-r1:8b', label: 'DeepSeek R1 8B (로컬)', vision: false, tools: true, reasoning: true }]
    }
  ];
}

class Store {
  constructor(root, registry) {
    this.root = root;
    this.reg = registry;
    this.data = path.join(root, 'data');
    this.dirs = {
      conversations: path.join(this.data, 'conversations'),
      uploads: path.join(this.data, 'uploads'),
      images: path.join(this.data, 'images'),
      skills: path.join(this.data, 'skills'),
      workspace: path.join(this.data, 'workspace'),
      logs: path.join(this.data, 'logs')
    };
    this.files = {
      settings: path.join(this.data, 'settings.json'),
      prompts: path.join(this.data, 'prompts.json'),
      mcp: path.join(this.data, 'mcp.json'),
      projects: path.join(this.data, 'projects.json'),
      routines: path.join(this.data, 'routines.json'),
      queue: path.join(this.data, 'queue.json')
    };
    this.convCache = new Map();
  }

  ensure() {
    fs.mkdirSync(this.data, { recursive: true });
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });

    if (!fs.existsSync(this.files.settings)) {
      const s = this.reg.applyDefaults('settings.schema.json', { providers: defaultProviders() });
      s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
      // Claude Code 스킬 폴더가 있으면 외부 스킬로 함께 불러온다
      const claudeSkills = path.join(require('os').homedir(), '.claude', 'skills');
      if (fs.existsSync(claudeSkills)) s.skills.extraDirs = [claudeSkills];
      this.writeJson(this.files.settings, s, 'settings.schema.json');
    }
    if (!fs.existsSync(this.files.prompts)) {
      this.writeJson(this.files.prompts, { version: 1, prompts: require('./seed').prompts(newId, now()) }, 'prompts.schema.json');
    }
    if (!fs.existsSync(this.files.mcp)) {
      this.writeJson(this.files.mcp, require('./seed').mcp(this.root), 'mcp.schema.json');
    }
    if (!fs.existsSync(this.files.projects)) this.writeJson(this.files.projects, { version: 1, projects: [] }, 'projects.schema.json');
    if (!fs.existsSync(this.files.routines)) this.writeJson(this.files.routines, { version: 1, routines: [] }, 'routines.schema.json');
    if (!fs.existsSync(this.files.queue)) this.writeJson(this.files.queue, this.reg.applyDefaults('queue.schema.json', { version: 1, settings: {}, jobs: [] }), 'queue.schema.json');
    require('./seed').skills(this.dirs.skills);
    this.settings = this.readJson(this.files.settings, 'settings.schema.json');
  }

  // ---------- 공통 JSON 입출력 ----------
  readJson(file, schemaId) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    this.reg.applyDefaults(schemaId, raw);
    const r = this.reg.validate(schemaId, raw);
    if (!r.valid) {
      const e = new Error(`${path.basename(file)} 파일이 스키마와 맞지 않습니다: ${r.errors.slice(0, 5).join(' / ')}`);
      e.details = r.errors;
      throw e;
    }
    return raw;
  }

  writeJson(file, obj, schemaId) {
    if (schemaId) this.reg.assert(schemaId, obj);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  // ---------- 설정 ----------
  getSettings() { return this.settings; }

  saveSettings(next) {
    this.reg.applyDefaults('settings.schema.json', next);
    this.writeJson(this.files.settings, next, 'settings.schema.json');
    this.settings = next;
    return next;
  }

  getProvider(id) {
    const s = this.settings;
    return s.providers.find((p) => p.id === id) || s.providers.find((p) => p.id === s.activeProviderId) || s.providers[0];
  }

  // ---------- 프롬프트 ----------
  getPrompts() { return this.readJson(this.files.prompts, 'prompts.schema.json'); }
  savePrompts(lib) { this.writeJson(this.files.prompts, lib, 'prompts.schema.json'); return lib; }

  // ---------- MCP 설정 ----------
  getMcpConfig() { return this.readJson(this.files.mcp, 'mcp.schema.json'); }
  saveMcpConfig(cfg) { this.reg.applyDefaults('mcp.schema.json', cfg); this.writeJson(this.files.mcp, cfg, 'mcp.schema.json'); return cfg; }

  // ---------- 프로젝트 · 루틴 (CONTEXT.md §10) ----------
  getProjects() { return this.readJson(this.files.projects, 'projects.schema.json'); }
  saveProjects(lib) { this.reg.applyDefaults('projects.schema.json', lib); this.writeJson(this.files.projects, lib, 'projects.schema.json'); return lib; }
  getProject(id) { return id ? this.getProjects().projects.find((p) => p.id === id) || null : null; }
  getRoutines() { return this.readJson(this.files.routines, 'routines.schema.json'); }
  getQueue() { return this.readJson(this.files.queue, 'queue.schema.json'); }
  saveQueue(q) { this.reg.applyDefaults('queue.schema.json', q); this.writeJson(this.files.queue, q, 'queue.schema.json'); return q; }
  saveRoutines(lib) { this.reg.applyDefaults('routines.schema.json', lib); this.writeJson(this.files.routines, lib, 'routines.schema.json'); return lib; }

  // ---------- 대화 ----------
  convPath(id) {
    if (!SAFE_ID.test(id)) { const e = new Error('잘못된 대화 ID'); e.status = 400; throw e; }
    return path.join(this.dirs.conversations, `${id}.json`);
  }

  listConversations() {
    const out = [];
    for (const f of fs.readdirSync(this.dirs.conversations)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = this.getConversation(f.slice(0, -5));
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, createdAt: c.createdAt, pinned: c.pinned, count: c.messages.length, projectId: c.projectId || null, archived: !!c.archived, routineId: c.routineId || null, watch: c.watch && c.watch.enabled ? c.watch.state || 'watching' : null });
      } catch (e) { console.error('[store] 대화 파일 읽기 실패', f, e.message); }
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  getConversation(id) {
    if (this.convCache.has(id)) return this.convCache.get(id);
    const file = this.convPath(id);
    if (!fs.existsSync(file)) { const e = new Error('대화를 찾을 수 없습니다'); e.status = 404; throw e; }
    const c = this.readJson(file, 'conversation.schema.json');
    this.convCache.set(id, c);
    return c;
  }

  createConversation(init = {}) {
    const c = this.reg.applyDefaults('conversation.schema.json', {
      id: newId(), title: init.title || '새 대화', createdAt: now(), updatedAt: now(), messages: [],
      providerId: init.providerId || '', model: init.model || '', systemPrompt: init.systemPrompt || '', skills: init.skills || [],
      projectId: init.projectId || null, routineId: init.routineId || null, queueJobId: init.queueJobId || null
    });
    this.saveConversation(c, false);
    return c;
  }

  saveConversation(c, touch = true) {
    if (touch) c.updatedAt = now();
    this.writeJson(this.convPath(c.id), c, 'conversation.schema.json');
    this.convCache.set(c.id, c);
    return c;
  }

  deleteConversation(id) {
    const file = this.convPath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.convCache.delete(id);
  }
}

module.exports = { Store, newId, now, SAFE_ID, defaultProviders, DEFAULT_SYSTEM_PROMPT };
