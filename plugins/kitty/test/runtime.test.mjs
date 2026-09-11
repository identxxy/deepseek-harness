import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../runtime.mjs';

function fixture() {
  let generation = '1';
  const calls = [];
  const pane = () => ({ socket: '/tmp/test', inode: '1', id: 4, created: 1, processes: generation, title: 'Codex', cwd: '/work' });
  const runtime = createRuntime({ discover: async () => [pane()], command: async (_pane, args, stdin) => {
    calls.push({ args, stdin }); await new Promise(resolve => setTimeout(resolve, 2)); return 'screen';
  }, config: { maxTextBytes: 100, maxImageBytes: 20, imageDirectory: '/unused' } });
  return { runtime, calls, change: () => { generation = '2'; } };
}
test('stale foreground identity cannot receive input', async () => {
  const { runtime, change, calls } = fixture();
  const [pane] = await runtime.list(); change();
  await assert.rejects(runtime.action({ token: pane.token, action: 'text', text: 'hello', submit: true }), /stale/);
  assert.equal(calls.length, 0);
});
test('literal text uses stdin; a complete paste and enter precede the next client', async () => {
  const { runtime, calls } = fixture(); const [pane] = await runtime.list();
  await Promise.all(['\\n hello', 'second'].map(text => runtime.action({ token: pane.token, action: 'text', text, submit: true })));
  assert.deepEqual(calls.map(c => c.args[0]), ['send-text', 'send-key', 'send-text', 'send-key']);
  assert.equal(calls[0].stdin, '\\n hello');
  assert.ok(calls[0].args.includes('--stdin'));
});
test('rejects malformed and oversized input before invoking Kitty', async () => {
  const { runtime, calls } = fixture(); const [pane] = await runtime.list();
  for (const input of [{ action: 'key', key: 'anything' }, { action: 'text', text: '\x1b[31m', submit: true }, { action: 'text', text: 'a'.repeat(101), submit: true }, { action: 'text', text: '', submit: true, image: {mime: 'text/html', data: 'YQ=='} }, { action: 'text', text: 'caption', submit: true, image: {mime: 'image/png', data: 'YQ=='.repeat(100)} }]) {
    await assert.rejects(runtime.action({ token: pane.token, ...input }));
  }
  assert.equal(calls.length, 0);
});
test('no implicit target and no stale reads', async () => {
  const { runtime, change } = fixture(); const [pane] = await runtime.list();
  await assert.rejects(runtime.screen(''), /target/);
  change(); await assert.rejects(runtime.screen(pane.token), /stale/);
});
test('process change after paste prevents submitting Enter', async () => {
  let generation = 1; const calls = [];
  const runtime = createRuntime({ config: { maxTextBytes: 100 }, discover: async () => [{socket:'test',inode:1,id:1,created:1,processes:generation}], command: async (_pane, args) => { calls.push(args[0]); generation++; } });
  const [pane] = await runtime.list();
  await assert.rejects(runtime.action({token:pane.token,action:'text',text:'hello',submit:true}), /stale/);
  assert.deepEqual(calls, ['send-text']);
});
test('image and caption form one safe paste, followed by one Enter', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'kitty-image-'));
  const calls = [];
  const runtime = createRuntime({config:{maxTextBytes:100,maxImageBytes:100,imageDirectory:directory},discover:async()=>[{socket:'test',inode:1,id:1,created:1,processes:1}],command:async(_p,args,stdin)=>{calls.push({args,stdin});}});
  try {
    const [pane] = await runtime.list();
    await runtime.action({token:pane.token,action:'text',text:'caption',image:{mime:'image/png',data:'aGVsbG8='},submit:true});
    assert.equal(calls.length,2);
    assert.match(calls[0].stdin,/caption\n\n\[image\]\(file:\/\//);
    assert.ok(!calls[0].stdin.startsWith('!'));
    const url = calls[0].stdin.match(/\[image\]\((.+)\)/)[1];
    assert.equal(await readFile(new URL(url),'utf8'),'hello');
    calls.length=0;
    await runtime.action({token:pane.token,action:'text',text:'',image:{mime:'image/png',data:'aGVsbG8='},submit:false});
    assert.equal(calls.length,1); assert.ok(calls[0].stdin.startsWith('[image]'));
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('new OS windows use the selected instance and cwd without executing draft text', async () => {
  const original = {socket:'/tmp/a',inode:'1',id:4,created:1,processes:'1',cwd:'/work with spaces'};
  const created = {...original,id:5};
  const other = {...created,socket:'/tmp/b'};
  let launched = false;
  const calls = [];
  const runtime = createRuntime({config:{},discover:async()=>launched ? [original,other,created] : [original],command:async(p,args)=>{calls.push({p,args});launched=true;return '5\n';}});
  const [source] = await runtime.list();
  const result = await runtime.action({token:source.token,action:'create',text:'ignored'});
  assert.deepEqual(calls,[{p:original,args:['launch','--type','os-window','--source-window','id:4','--cwd','/work with spaces','--keep-focus']}]);
  assert.equal(result.instance,(await runtime.list())[2].instance);
  assert.notEqual(result.instance,(await runtime.list())[1].instance);
  assert.equal(result.created,true);
});
test('stale selections cannot create a window', async () => {
  const {runtime,change,calls} = fixture();
  const [pane] = await runtime.list(); change();
  await assert.rejects(runtime.action({token:pane.token,action:'create'}),/stale_target/);
  assert.equal(calls.length,0);
});
