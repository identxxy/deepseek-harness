/** Identity-checked operations on existing Kitty panes. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KEYS = ['enter', 'escape', 'tab', 'up', 'down', 'left', 'right', 'home', 'end', 'backspace', 'ctrl+c', 'ctrl+d', 'ctrl+a', 'ctrl+e', 'ctrl+l', 'ctrl+u'];
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif' };

/** Build a runtime with process discovery and a bounded Kitty command executor. */
export function createRuntime({ discover, command, config }) {
  const secret = randomBytes(32);
  const queues = new Map();
  let queued = 0;
  const instance = p => createHmac('sha256', secret).update(JSON.stringify([p.socket, p.inode])).digest('hex');
  const token = p => createHmac('sha256', secret).update(JSON.stringify([p.socket, p.inode, p.id, p.created, p.processes])).digest('hex');
  async function resolve(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid_target');
    const pane = (await discover()).find(p => token(p) === value);
    if (!pane) throw new Error('stale_target');
    return pane;
  }
  async function list() {
    return (await discover()).map(p => ({ token: token(p), instance: instance(p), id: p.id, title: p.title, cwd: p.cwd, program: p.program, pid: p.pid }));
  }
  async function screen(value, extent = 'screen') {
    if (!['screen', 'all'].includes(extent)) throw new Error('invalid_extent');
    const pane = await resolve(value);
    const text = await command(pane, ['get-text', '--match', `id:${pane.id}`, '--extent', extent, '--ansi']);
    await resolve(value);
    return { text };
  }
  async function execute(input) {
    const pane = await resolve(input.token);
    const match = ['--match', `id:${pane.id}`];
    if (input.action === 'create') {
      const output = await command(pane, ['launch', '--type', 'os-window', '--source-window', `id:${pane.id}`, '--cwd', pane.cwd, '--keep-focus']);
      const id = Number(output.trim());
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid_kitty_response');
      return { created: true, id, instance: instance(pane) };
    }
    if (input.action === 'key') {
      if (!KEYS.includes(input.key)) throw new Error('invalid_key');
      await command(pane, ['send-key', ...match, input.key]);
    } else {
      if (input.action !== 'text') throw new Error('invalid_action');
      if (typeof input.text !== 'string' || (!input.text.trim() && !input.image) || Buffer.byteLength(input.text) > config.maxTextBytes || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.text) || typeof input.submit !== 'boolean') throw new Error('invalid_text');
      let text = input.text;
      if (input.image !== undefined) {
        const attachment = input.image;
        if (!attachment || !Object.hasOwn(IMAGE_TYPES, attachment.mime) || typeof attachment.data !== 'string' || attachment.data.length > Math.ceil(config.maxImageBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.data)) throw new Error('invalid_image');
        const bytes = Buffer.from(attachment.data, 'base64');
        if (!bytes.length || bytes.length > config.maxImageBytes) throw new Error('invalid_image');
        const directory = join(config.imageDirectory, new Date().toISOString().slice(0, 10).replaceAll('-', ''));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${Date.now()}-${randomUUID()}${IMAGE_TYPES[attachment.mime]}`);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        // A leading exclamation mark selects shell mode in Codex's composer.
        const reference = `[image](${pathToFileURL(path).href})`;
        text = text.trim() ? `${text}\n\n${reference}` : reference;
      }
      await resolve(input.token);
      await command(pane, ['send-text', ...match, '--stdin', '--bracketed-paste', 'auto'], text);
      if (input.submit === true) {
        await resolve(input.token);
        await command(pane, ['send-key', ...match, 'enter']);
      }
    }
    return { delivered: true };
  }
  function action(input) {
    if (!input || typeof input.token !== 'string') return Promise.reject(new Error('invalid_target'));
    if (queued >= (config.maxQueuedActions ?? 16)) return Promise.reject(new Error('queue_full'));
    queued++;
    const key = input.token;
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => { /* A failed delivery must not block later explicitly requested input. */ }).then(() => execute(input));
    queues.set(key, next);
    return next.finally(() => { queued--; if (queues.get(key) === next) queues.delete(key); });
  }
  return { list, screen, action };
}
