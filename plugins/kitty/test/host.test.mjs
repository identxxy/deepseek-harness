import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../host-plugin.js';
import { resolveConfig } from '../local.mjs';
import { renderAnsiTerminalText } from '../src/client/ansi.mjs';
async function call(status, method = 'GET', body = '', headers = {}) {
  let invoked = false; let code; let result;
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method, url: '/api/dsh/kitty', headers });
  const res = { writeHead(value) { code = value; }, end(value) { result = JSON.parse(value); } };
  await createHandler({ connection: { requestRejection: () => status } }, { list: async () => { invoked = true; return []; }, action: async () => { invoked = true; return {}; } }, resolveConfig())(req, res);
  return { code, invoked, result };
}
test('every route rejects unauthenticated or untrusted requests before work', async () => {
  for (const status of [401, 403]) for (const method of ['GET', 'POST']) {
    const result = await call(status, method); assert.equal(result.code, status); assert.equal(result.invoked, false);
  }
});
test('authenticated reads work and malformed mutations never reach Kitty', async () => {
  assert.equal((await call(undefined)).code, 200);
  assert.equal((await call(undefined, 'POST')).code, 415);
  assert.equal((await call(undefined, 'POST', '{', { 'content-type': 'application/json' })).code, 400);
});
test('ANSI snapshots escape markup and reject executable OSC hyperlinks', () => {
  assert.ok(!renderAnsiTerminalText('<img src=x onerror=alert(1)>').includes('<img'));
  assert.ok(!renderAnsiTerminalText('\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x07').includes('href='));
  assert.match(renderAnsiTerminalText('\x1b[31mred\x1b[0m'), /color: #cd3131/);
});
