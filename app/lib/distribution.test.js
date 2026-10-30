'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SchemaRegistry } = require('./schema');
const { Store, defaultProviders } = require('./store');
const seed = require('./seed');

test('fresh installs select official DeepSeek 4.1 without company endpoints or credentials', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-distribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new SchemaRegistry(path.resolve(__dirname, '../../schemas'));
  const store = new Store(root, registry);
  store.ensure();
  const settings = store.getSettings();
  assert.equal(settings.activeProviderId, 'deepseek');
  assert.equal(settings.activeModel, 'deepseek-flash');
  const selected = store.getProvider(settings.activeProviderId).models.find((model) => model.id === settings.activeModel);
  assert.match(selected.label, /V4\.1/);
  assert.equal(selected.vision, true);
  assert.equal(selected.tools, true);
  assert.equal(selected.contextWindow, 1048576);
  assert.ok(settings.providers.every((provider) => provider.apiKey === '' && !Object.keys(provider.headers || {}).length));
  assert.ok(settings.providers.every((provider) => provider.models.every((model) => !model.id.startsWith('ep-'))));
  assert.equal(fs.readdirSync(store.dirs.conversations).length, 0);
  assert.equal(store.getQueue().jobs.length, 0);
  assert.equal(seed.mcp(root).mcpServers['echo-test'].command, process.execPath);

  // A restart/upgrade must not replace a user's deliberately changed model or saved messages.
  settings.activeProviderId = 'ollama';
  settings.activeModel = 'employee-local-choice';
  store.saveSettings(settings);
  const conversation = store.createConversation({ title: 'Keep employee work' });
  const restarted = new Store(root, registry);
  restarted.ensure();
  assert.equal(restarted.getSettings().activeModel, 'employee-local-choice');
  assert.equal(restarted.getConversation(conversation.id).title, 'Keep employee work');
});

test('official DeepSeek 4.1 remains available with the documented vision/tool model ID', () => {
  const provider = defaultProviders().find((item) => item.id === 'deepseek');
  const model = provider.models.find((item) => item.id === 'deepseek-flash');
  assert.equal(provider.baseUrl, 'https://api.deepseek.com');
  assert.equal(provider.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(model.vision, true);
  assert.equal(model.tools, true);
  assert.match(model.label, /V4\.1/);
});
