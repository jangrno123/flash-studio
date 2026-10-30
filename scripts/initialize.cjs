'use strict';
// Initialize storage only. Do not start a server, queue, MCP client or model request.
const path = require('node:path');
const { SchemaRegistry } = require('../app/lib/schema');
const { Store } = require('../app/lib/store');
const root = path.resolve(__dirname, '..');
const store = new Store(root, new SchemaRegistry(path.join(root, 'schemas')));
store.ensure();
console.log('Flash Studio: local data initialized. Existing settings preserved.');
