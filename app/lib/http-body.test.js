'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { readBody } = require('./http-body');
test('oversized HTTP request returns readable 413, subsequent request still succeeds', async t => {
  const server = http.createServer(async (req, res) => {
    try { const body = await readBody(req, 1024); res.end(JSON.stringify({ bytes: body.length })); }
    catch (e) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(url, { method: 'POST', body: Buffer.alloc(4096) });
  assert.equal(response.status, 413); assert.match((await response.json()).error, /요청이 너무 큽니다/);
  const next = await fetch(url, { method: 'POST', body: 'OK' });
  assert.equal(next.status, 200); assert.equal((await next.json()).bytes, 2);
});
