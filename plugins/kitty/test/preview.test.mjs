import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreview } from '../preview.mjs';
import { createPreviewHandler } from '../host-plugin.js';
import { resolveConfig } from '../local.mjs';

async function fixture(t, values = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kitty-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig(values);
  const preview = createPreview(config);
  t.after(() => preview.close());
  const file = async (path, value) => {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, value);
    return pathToFileURL(full).href;
  };
  return { root, config, preview, file };
}
async function server(t, handler) {
  const server = createServer(handler);
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const linux = { skip: process.platform !== 'linux' && 'Local Kitty preview requires Linux fd resolution' };

test('local reports inline unquoted HTML, CSS imports, images and scripts without exposing scope', linux, async t => {
  const { preview, file } = await fixture(t);
  await file('report/assets/base.css', 'h1 { color: rgb(1, 2, 3) }');
  await file('report/assets/report.css', '@import "base.css"; body { background-image: url(icon.svg) }');
  await file('report/assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await file('report/assets/report.js', 'document.body.dataset.ready="yes"');
  const url = await file('report/index.html', '<base href="./assets/"><meta http-equiv="refresh" content="0;url=/"><link rel=stylesheet href=report.css><style>p{background:url(icon.svg)}</style><h1>Report</h1><img src=icon.svg><script src=report.js></script><a href="../next.html">Next</a>');
  const result = await preview.render({ url });
  assert.match(result.html, /src="data:image\/svg\+xml;base64,/);
  assert.match(result.html, /src="data:text\/javascript;base64,/);
  assert.match(result.html, /href="data:text\/css;base64,/);
  const css = Buffer.from(result.html.match(/href="data:text\/css;base64,([^"]+)"/)[1], 'base64').toString();
  assert.match(css, /@import "data:text\/css;base64,/);
  assert.match(css, /url\(data:image\/svg\+xml;base64,/);
  assert.match(result.html, /href="file:.*\/report\/next.html"/);
  assert.match(result.html, /<base href="file:.*\/report\/assets\/">/);
  assert.doesNotMatch(result.html, /http-equiv|scope/);
  assert.ok(!result.html.includes(result.scope));
});

test('automatic file reads retain the selected real directory and decode paths once', linux, async t => {
  const { preview, file, root } = await fixture(t);
  const url = await file('report/index.html', '<h1>Report</h1>');
  const next = await file('report/next.html', '<h1>Next</h1>');
  const data = await file('report/%2e%2e.json', '{"ok":true}');
  const outside = await file('private/secret.txt', 'PRIVATE_VALUE');
  await symlink(join(root, 'private', 'secret.txt'), join(root, 'report', 'escape.txt'));
  const { scope } = await preview.render({ url });
  assert.match((await preview.render({ url: next, scope })).html, /Next/);
  assert.equal(Buffer.from((await preview.render({ url: data, scope, resource: true })).data, 'base64').toString(), '{"ok":true}');
  for (const target of [outside, new URL('../private/secret.txt', url).href, new URL('escape.txt', url).href, 'http://localhost/']) {
    await assert.rejects(preview.render({ url: target, scope }), /preview_scope_forbidden/);
  }
  await assert.rejects(preview.render({ url, scope: scope + 'x' }), /preview_scope_forbidden/);
  await assert.rejects(preview.render({ url, resource: true }), /preview_scope_forbidden/);
  assert.match((await preview.render({ url: outside })).html, /PRIVATE_VALUE/);
});

test('HTTP reports load same-origin assets and preserve status for read-only fetches', async t => {
  const { preview } = await fixture(t);
  const cookies = [];
  const origin = await server(t, (request, response) => {
    cookies.push(request.headers.cookie);
    if (request.url === '/start') { response.writeHead(302, { location: '/report/index.html' }); response.end(); return; }
    if (request.url === '/report/index.html') { response.setHeader('content-type', 'text/html'); response.end('<link rel=stylesheet href=style.css><link rel=stylesheet href=alias.css><h1>HTTP</h1>'); return; }
    if (request.url === '/report/alias.css') { response.writeHead(302, { location: 'style.css' }); response.end(); return; }
    if (request.url === '/report/style.css') { response.setHeader('content-type', 'text/css'); response.end('h1{color:red}'); return; }
    response.writeHead(404, { 'content-type': 'text/plain' }); response.end('missing');
  });
  const page = await preview.render({ url: origin + '/start' });
  assert.equal(page.url, origin + '/report/index.html');
  assert.match(page.html, /data:text\/css;base64,/);
  const resource = await preview.render({ url: origin + '/missing', scope: page.scope, resource: true });
  assert.equal(resource.status, 404);
  assert.equal(Buffer.from(resource.data, 'base64').toString(), 'missing');
  assert.deepEqual(cookies, Array(cookies.length).fill(undefined));
});

test('HTTP redirects cannot change origin, protocol or credentials and fragment loops terminate', { timeout: 10_000 }, async t => {
  const { preview } = await fixture(t);
  let crossed = false;
  const other = await server(t, (_request, response) => { crossed = true; response.end('private'); });
  const origin = await server(t, (request, response) => {
    const locations = { '/origin': other, '/file': 'file:///etc/passwd', '/credentials': `http://user:pass@${request.headers.host}/`, '/loop': '#again' };
    response.writeHead(302, { location: locations[request.url] }); response.end();
  });
  for (const path of ['/origin', '/file', '/credentials']) await assert.rejects(preview.render({ url: origin + path }), /preview_(scope_forbidden|invalid_url)/);
  await assert.rejects(preview.render({ url: origin + '/loop' }), /preview_redirect_loop/);
  assert.equal(crossed, false);
});

test('raw bytes, emitted output, CSS expansion and resource counts are bounded', linux, async t => {
  const { file } = await fixture(t);
  const cases = [
    [await file('large.txt', 'x'.repeat(4097)), { previewMaxBytes: 4096 }, /preview_too_large/],
    [await file('escaped.txt', '<'.repeat(300)), { previewMaxBytes: 1024 }, /preview_too_large/],
  ];
  await file('style.css', 'h1{--padding:' + 'x'.repeat(500) + '}');
  cases.push([await file('expanded.html', '<link rel=stylesheet href=style.css>'.repeat(8)), { previewMaxBytes: 2048 }, /preview_too_large/]);
  await file('one.svg', '<svg/>'); await file('two.svg', '<svg/>');
  cases.push([await file('many.html', '<img src=one.svg><img src=two.svg>'), { previewMaxResources: 2 }, /preview_too_many_resources/]);
  for (const [url, limits, error] of cases) {
    const preview = createPreview(resolveConfig(limits));
    try { await assert.rejects(preview.render({ url }), error); }
    finally { await preview.close(); }
  }
});

test('streaming bytes are bounded without a content length', async t => {
  const { preview } = await fixture(t, { previewMaxBytes: 1024 });
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('x'.repeat(512)); response.end('y'.repeat(1024));
  });
  await assert.rejects(preview.render({ url: origin }), /preview_too_large/);
});

test('closing cancels and drains an active HTTP body and rejects new work', { timeout: 10_000 }, async t => {
  const { preview } = await fixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<h1>');
    started();
  });
  const read = assert.rejects(preview.render({ url: origin }), /preview_cancelled/);
  await ready;
  await preview.close();
  await read;
  await assert.rejects(preview.render({ url: origin }), /preview_cancelled/);
});

test('FIFO and missing paths fail without blocking shutdown', { ...linux, timeout: 10_000 }, async t => {
  const { root, preview } = await fixture(t);
  const fifo = join(root, 'pipe');
  await promisify(execFile)('mkfifo', [fifo]);
  await assert.rejects(preview.render({ url: pathToFileURL(fifo).href }), /preview_not_a_file/);
  await assert.rejects(preview.render({ url: pathToFileURL(join(root, 'absent.html')).href }), /preview_not_found/);
  await preview.close();
});

test('simultaneous preview requests are capped and caller cancellation releases the reader', { timeout: 10_000 }, async t => {
  const { preview } = await fixture(t, { maxQueuedActions: 1 });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const origin = await server(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    if (request.url === '/fast') { response.end('finished'); return; }
    response.write('pending'); started();
  });
  const controller = new AbortController();
  const read = assert.rejects(preview.render({ url: origin }, controller.signal), /preview_cancelled/);
  await ready;
  await assert.rejects(preview.render({ url: origin + '/fast' }), /preview_busy/);
  controller.abort();
  await read;
  assert.match((await preview.render({ url: origin + '/fast' })).html, /finished/);
});

test('the configured timeout cancels a response that never finishes', { timeout: 10_000 }, async t => {
  const { preview } = await fixture(t, { timeoutMs: 25 });
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }); response.write('pending');
  });
  await assert.rejects(preview.render({ url: origin }), /preview_cancelled/);
});

test('cancellation during file setup completes without an unhandled stream error', linux, async t => {
  const { preview, file } = await fixture(t);
  const url = await file('report.html', '<h1>Report</h1>');
  const handle = await open(new URL(url), 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const stat = prototype.stat;
  const controller = new AbortController();
  // Node runs this file's tests sequentially; t.mock restores the prototype before the next case.
  t.mock.method(prototype, 'stat', async function (...args) {
    const result = await stat.apply(this, args);
    controller.abort();
    return result;
  });
  await assert.rejects(preview.render({ url }, controller.signal), /preview_cancelled/);
  await preview.close();
});

test('preview routes authenticate every JSON request before report reads', async t => {
  const config = resolveConfig({ maxTextBytes: 128 });
  let rejection = 401;
  let invoked = 0;
  const origin = await server(t, createPreviewHandler({ connection: { requestRejection: () => rejection } }, {
    async render() { invoked++; return { html: '<p>Report</p>' }; },
  }, config));
  for (const status of [401, 403]) {
    rejection = status;
    const response = await fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, status);
    await response.text();
  }
  assert.equal(invoked, 0);
  rejection = undefined;
  for (const [init, status] of [
    [{}, 405],
    [{ method: 'POST', body: '{}' }, 415],
    [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }, 400],
    [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(129) }, 413],
    [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 200],
  ]) {
    const response = await fetch(origin, init);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    await response.text();
  }
  assert.equal(invoked, 1);
});
