/** Bounded report reads with selected navigation and configured static asset directories. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookup } from 'mime-types';
import { prepareHtml, escapeHtml } from './preview-html.mjs';

function reportUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('preview_invalid_url'); }
  if (!['file:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'file:' && url.host && url.host !== 'localhost')) throw new Error('preview_invalid_url');
  return url;
}

function inside(directory, path) {
  const child = relative(directory, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

/**
 * Own report reads and signed directory/origin restrictions until plugin disposal.
 * @param config - validated Kitty limits; timeoutMs covers each document and its assets.
 * @returns authenticated-route operations and an aborting, draining close method.
 */
export function createPreview(config) {
  const secret = randomBytes(32);
  const closing = new AbortController();
  const pending = new Set();
  const sign = value => createHmac('sha256', secret).update(value).digest();
  function encode(scope) {
    const body = Buffer.from(JSON.stringify(scope)).toString('base64url');
    return `${body}.${sign(body).toString('base64url')}`;
  }
  function decode(value) {
    if (typeof value !== 'string') throw new Error('preview_scope_forbidden');
    const [body, signature, extra] = value.split('.');
    const actual = Buffer.from(signature ?? '', 'base64url');
    const expected = sign(body ?? '');
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('preview_scope_forbidden');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  }
  async function run(input, requestSignal) {
    if (!input || typeof input !== 'object' || typeof input.url !== 'string' || (input.resource !== undefined && typeof input.resource !== 'boolean')) throw new Error('preview_invalid_request');
    const initial = reportUrl(input.url);
    if (input.resource && input.scope === undefined) throw new Error('preview_scope_forbidden');
    let scope;
    let assetDirectories;
    const deadline = performance.now() + config.timeoutMs;
    const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(config.timeoutMs), ...(requestSignal ? [requestSignal] : [])]);
    let bytes = 0;
    let count = 0;
    const cache = new Map();
    function charge(size) {
      bytes += size;
      if (bytes > config.previewMaxBytes) throw new Error('preview_too_large');
      signal.throwIfAborted();
    }
    async function read(target, redirects = new Set(), asset = false) {
      signal.throwIfAborted();
      const url = reportUrl(target);
      url.hash = '';
      if (redirects.has(url.href)) throw new Error('preview_redirect_loop');
      if (cache.has(url.href)) return cache.get(url.href);
      if (++count > config.previewMaxResources) throw new Error('preview_too_many_resources');
      const task = (async () => {
        if (scope.kind === 'file') {
          if (url.protocol !== 'file:') throw new Error('preview_scope_forbidden');
          if (asset) assetDirectories ??= await Promise.all(config.previewAssetDirectories.map(directory => realpath(directory)));
          const allowed = path => inside(scope.directory, path) || (asset && assetDirectories.some(directory => inside(directory, path)));
          let path = await realpath(fileURLToPath(url));
          if (!allowed(path)) throw new Error('preview_scope_forbidden');
          const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (!stat.isFile()) throw new Error('preview_not_a_file');
            // Linux fd resolution checks the opened file even if a parent directory was replaced.
            path = await realpath(`/proc/self/fd/${file.fd}`);
            if (!allowed(path)) throw new Error('preview_scope_forbidden');
            if (stat.size > config.previewMaxBytes - bytes) throw new Error('preview_too_large');
            const chunks = [];
            signal.throwIfAborted();
            for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
              charge(chunk.length);
              chunks.push(chunk);
            }
            return { url: pathToFileURL(path).href + url.search, data: Buffer.concat(chunks), contentType: lookup(path) || 'application/octet-stream', status: 200 };
          } finally { await file.close(); }
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== scope.origin) throw new Error('preview_scope_forbidden');
        const response = await fetch(url, { signal, redirect: 'manual', credentials: 'omit' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location) throw new Error('preview_fetch_failed');
          const next = new URL(location, url);
          next.hash = '';
          return read(next.href, new Set([...redirects, url.href]), asset);
        }
        const chunks = [];
        try {
          if (Number(response.headers.get('content-length')) > config.previewMaxBytes - bytes) throw new Error('preview_too_large');
          if (response.body) for await (const chunk of response.body) {
            charge(chunk.length);
            chunks.push(Buffer.from(chunk));
          }
        } finally { if (response.body && !response.body.locked) await response.body.cancel(); }
        return { url: url.href, data: Buffer.concat(chunks), contentType: response.headers.get('content-type') ?? 'application/octet-stream', status: response.status };
      })();
      cache.set(url.href, task);
      return task;
    }
    try {
      scope = input.scope === undefined
        ? initial.protocol === 'file:'
          ? { kind: 'file', directory: dirname(await realpath(fileURLToPath(initial))) }
          : { kind: 'http', origin: initial.origin }
        : decode(input.scope);
      const resource = await read(initial.href);
      let result;
      if (input.resource) result = { ...resource, data: resource.data.toString('base64') };
      else {
        if (resource.status < 200 || resource.status >= 300) throw new Error('preview_fetch_failed');
        const type = resource.contentType.split(';')[0].trim().toLowerCase();
        let html;
        if (type === 'text/html' || type === 'application/xhtml+xml') html = await prepareHtml(resource, target => read(target, new Set(), true), config.previewMaxBytes);
        else if (type.startsWith('text/') || type === 'application/json') html = `<html><head></head><body><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(resource.data.toString('utf8'))}</pre></body></html>`;
        else if (/^(image|audio|video)\//.test(type)) {
          const tag = type.startsWith('image/') ? 'img' : type.split('/')[0];
          html = `<html><head></head><body><${tag} controls style="max-width:100%" src="data:${escapeHtml(type)};base64,${resource.data.toString('base64')}"></${tag}></body></html>`;
        } else throw new Error('preview_unsupported_type');
        result = { url: resource.url + initial.hash, scope: input.scope ?? encode(scope), html };
      }
      signal.throwIfAborted();
      if (performance.now() > deadline) throw new Error('preview_cancelled');
      if (Buffer.byteLength(JSON.stringify(result)) > config.previewMaxBytes) throw new Error('preview_too_large');
      return result;
    } catch (error) {
      if (signal.aborted) throw new Error('preview_cancelled');
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('preview_not_found');
      if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('preview_scope_forbidden');
      if (error.message.startsWith('preview_')) throw error;
      throw new Error('preview_fetch_failed');
    }
  }
  return {
    async render(input, signal) {
      if (closing.signal.aborted) throw new Error('preview_cancelled');
      if (pending.size >= config.maxQueuedActions) throw new Error('preview_busy');
      const task = run(input, signal);
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    },
    async close() { closing.abort(); await Promise.allSettled([...pending]); },
  };
}
