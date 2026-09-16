/** Local Linux Kitty discovery and cancellable DSH subprocess execution. */
import { readdir, stat, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export function resolveConfig(value = {}) {
  const config = { binary: 'kitty', socketDirectory: '/tmp', socketPrefix: 'kitty.sock-', timeoutMs: 20_000, graceMs: 500, maxOutputBytes: 4 * 1024 * 1024, maxTextBytes: 128 * 1024, maxImageBytes: 8 * 1024 * 1024, maxQueuedActions: 16, pollIntervalMs: 5000, scrollDebounceMs: 70, scrollPixelsPerLine: 42, touchScrollSensitivity: 5, maxScrollLines: 80, previewMaxBytes: 64 * 1024 * 1024, previewMaxResources: 64, imageDirectory: join(homedir(), 'Pictures', 'voxpress'), ...value };
  for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes', 'maxTextBytes', 'maxImageBytes', 'maxQueuedActions', 'pollIntervalMs', 'scrollDebounceMs', 'maxScrollLines', 'previewMaxBytes', 'previewMaxResources']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid Kitty configuration: ${key}`);
  }
  for (const key of ['scrollPixelsPerLine', 'touchScrollSensitivity']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid Kitty configuration: ${key}`);
  }
  for (const key of ['socketDirectory', 'imageDirectory']) if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`Kitty ${key} must be absolute`);
  if (typeof config.binary !== 'string' || !config.binary || typeof config.socketPrefix !== 'string' || !config.socketPrefix || config.socketPrefix.includes('/')) throw new Error('Invalid Kitty binary or socket prefix');
  return config;
}

export function createLocal(ctx, config) {
  const closing = new AbortController();
  const pending = new Set();
  async function command(pane, args, input) {
    if (closing.signal.aborted) throw new Error('runtime_closed');
    const task = (async () => {
      const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(config.timeoutMs)]);
      const handle = await ctx.subprocess.spawn({
        argv: [config.binary, '@', '--to', `unix:${pane.socket}`, ...args], cwd: homedir(),
        stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: 8192 } },
        graceMs: config.graceMs, signal,
      });
      const result = await handle.done;
      if (signal.aborted) throw new Error('kitty_timeout_or_closed');
      if (result.exitCode !== 0) throw new Error('kitty_command_failed');
      const output = handle.collected.stdout.readFrom(0);
      if (output.lossy) throw new Error('kitty_output_too_large');
      return output.text;
    })();
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  async function processIdentity(pid) {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    return [pid, value.slice(value.lastIndexOf(')') + 2).split(' ')[19]];
  }
  async function discover() {
    const result = [];
    const entries = await readdir(config.socketDirectory);
    for (const name of entries.filter(name => name.startsWith(config.socketPrefix)).sort()) {
      const socket = join(config.socketDirectory, name);
      let info;
      try { info = await stat(socket); } catch (error) {
        if (error.code === 'ENOENT') continue; // A Kitty instance closed during enumeration.
        throw error;
      }
      if (!info.isSocket() || info.uid !== process.getuid()) continue;
      const tree = JSON.parse(await command({ socket }, ['ls']));
      if (!Array.isArray(tree)) throw new Error('invalid_kitty_response');
      for (const os of tree) for (const tab of os.tabs) for (const pane of tab.windows) {
        if (!Number.isSafeInteger(pane.id) || !Number.isSafeInteger(pane.pid) || !Array.isArray(pane.foreground_processes)) throw new Error('invalid_kitty_response');
        let identities;
        try { identities = await Promise.all([pane.pid, ...pane.foreground_processes.map(p => p.pid)].map(processIdentity)); } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; // The process exited during discovery.
          throw error;
        }
        result.push({ socket, inode: `${info.dev}:${info.ino}`, id: pane.id, created: pane.created_at, processes: JSON.stringify(identities.sort((a, b) => a[0] - b[0])), title: pane.title, cwd: pane.foreground_processes[0]?.cwd ?? pane.cwd, program: pane.foreground_processes.map(p => p.cmdline[0]).join(', '), pid: pane.foreground_processes[0]?.pid ?? pane.pid });
      }
    }
    return result;
  }
  return { discover, command, async close() { closing.abort(); await Promise.allSettled([...pending]); } };
}
