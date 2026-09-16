/** Authenticated HTTP interface for an existing local Kitty terminal. */
import { createRuntime } from './runtime.mjs';
import { createLocal, resolveConfig } from './local.mjs';
import { createPreview } from './preview.mjs';

export const inject = ['webServer', 'connection', 'subprocess'];
export function createHandler(ctx, runtime, config) {
  return async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(value));
    };
    const rejection = ctx.connection.requestRejection(request);
    if (rejection) return reply(rejection, { error: 'authentication_required' });
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url, 'http://dsh.invalid');
        const token = url.searchParams.get('token');
        return reply(200, token === null ? { panes: await runtime.list(), pollIntervalMs: config.pollIntervalMs, maxImageBytes: config.maxImageBytes, scroll: { debounceMs: config.scrollDebounceMs, pixelsPerLine: config.scrollPixelsPerLine, touchSensitivity: config.touchScrollSensitivity, maxLines: config.maxScrollLines } } : await runtime.screen(token, url.searchParams.get('extent') ?? 'screen'));
      }
      if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return reply(415, { error: 'json_required' });
      const limit = Math.ceil(config.maxImageBytes / 3) * 4 + config.maxTextBytes + 4096;
      if (Number(request.headers['content-length']) > limit) return reply(413, { error: 'request_too_large' });
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) return reply(413, { error: 'request_too_large' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return reply(200, await runtime.action(input));
    } catch (error) {
      const code = error instanceof SyntaxError ? 'invalid_json' : error.message;
      const known = /^(invalid_|stale_|kitty_|runtime_|queue_)/.test(code);
      return reply(code === 'stale_target' ? 409 : known ? 400 : 500, { error: known ? code : 'kitty_operation_failed' });
    }
  };
}

/**
 * Serve JSON report previews through the existing Connection authentication and origin checks.
 * @param ctx - Host context with the Connection request fence.
 * @param preview - scoped report reader owned by this plugin.
 * @param config - validated request and resource limits.
 * @returns an HTTP handler that aborts work when its response disconnects.
 */
export function createPreviewHandler(ctx, preview, config) {
  return async (request, response) => {
    const reply = (status, value) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(value));
    };
    const rejection = ctx.connection.requestRejection(request);
    if (rejection) return reply(rejection, { error: 'authentication_required' });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') return reply(415, { error: 'json_required' });
    if (Number(request.headers['content-length']) > config.maxTextBytes) return reply(413, { error: 'request_too_large' });
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > config.maxTextBytes) return reply(413, { error: 'request_too_large' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return reply(200, await preview.render(input, controller.signal));
    } catch (error) {
      const code = error instanceof SyntaxError ? 'invalid_json' : error.message;
      return reply(code === 'preview_busy' ? 429 : 400, { error: /^(preview_|invalid_json$)/.test(code) ? code : 'preview_fetch_failed' });
    } finally { response.off('close', disconnect); }
  };
}

export function apply(ctx, value) {
  const config = resolveConfig(value);
  const local = createLocal(ctx, config);
  const runtime = createRuntime({ ...local, config });
  const preview = createPreview(config);
  ctx.effect(() => () => local.close(), 'kitty: stop helper processes');
  ctx.effect(() => () => preview.close(), 'kitty: stop report reads');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/dsh/kitty', handler: createHandler(ctx, runtime, config) }), 'kitty: HTTP route');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/dsh/kitty/preview', handler: createPreviewHandler(ctx, preview, config) }), 'kitty: report preview route');
  ctx.on('webserver/index-inject', rows => rows.push({ kind: 'html', placement: 'head', html: '<link rel="preload" as="fetch" href="/api/dsh/kitty" crossorigin="anonymous">' }));
}
