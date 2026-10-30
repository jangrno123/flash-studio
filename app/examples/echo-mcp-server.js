#!/usr/bin/env node
'use strict';
// MCP 연결 확인용 최소 stdio 서버. 도구 2개(echo, add)와 프롬프트 1개를 제공한다.
const readline = require('readline');

const tools = [
  { name: 'echo', description: '받은 문장을 그대로 돌려준다 (MCP 연결 테스트용)', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: '두 수를 더한다', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }
];
const prompts = [
  { name: 'greet', description: '인사말 프롬프트 예시', arguments: [{ name: 'name', description: '이름', required: false }] }
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // 알림
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'echo-test', version: '1.0.0' } });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools });
    case 'prompts/list': return ok({ prompts });
    case 'prompts/get':
      return ok({ messages: [{ role: 'user', content: { type: 'text', text: `${msg.params?.arguments?.name || '친구'}에게 따뜻한 인사말을 세 가지 버전으로 써줘.` } }] });
    case 'tools/call': {
      const { name, arguments: a = {} } = msg.params || {};
      if (name === 'echo') return ok({ content: [{ type: 'text', text: String(a.text ?? '') }] });
      if (name === 'add') return ok({ content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] });
      return ok({ content: [{ type: 'text', text: `알 수 없는 도구: ${name}` }], isError: true });
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
