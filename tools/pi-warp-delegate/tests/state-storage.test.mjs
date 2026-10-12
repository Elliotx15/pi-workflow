import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parentContext, groupName, reportBinding, sessionId } from '../dist/context.js';
import { Store, withLock } from '../dist/storage.js';
import { isTerminal, parseReportState, REPORT_STATES, TASK_STATES, transition } from '../dist/state-machine.js';
import { cliPath, fixture, runProcess } from './helpers.mjs';

for (const current of TASK_STATES) {
  for (const next of REPORT_STATES) {
    test(`transition ${current} → ${next}`, () => {
      if (isTerminal(current) && current !== next) {
        assert.throws(() => transition(current, next), { code: 'TERMINAL_STATE' });
      } else assert.equal(transition(current, next), next);
    });
  }
}

test('launching and unknown values are not reportable; IDs cannot traverse paths', () => {
  for (const state of ['launching', 'unknown', 'interrupted', '', 'done', 'COMPLETED']) {
    assert.throws(() => parseReportState(state), { exitCode: 2 });
  }
  for (const id of ['../x', '.', '..', '/absolute', 'x/y', 'x\\y', '-bad', 'bad-', 'a\0b', 'a'.repeat(129)]) {
    assert.throws(() => sessionId(id), { exitCode: 2 });
  }
  assert.equal(sessionId('valid_123.a-b'), 'valid_123.a-b');
  assert.equal(sessionId('a'), 'a');
});

test('workspace names are bounded, safe and stable; full workspace identity prevents basename collisions', async (t) => {
  const f = fixture(t, " ' {{param}} $() `ticks`\n中文");
  const ctx = await parentContext(f.runtime, {});
  assert.equal(ctx.directory, join(f.home, '.pi-warp-delegate', groupName(f.workspace, f.env.PI_SESSION_ID)));
  assert.doesNotMatch(ctx.directory.split('/').at(-1), /[\n{}'` ]/);
  assert.ok(Buffer.byteLength(groupName('/' + '汉'.repeat(80), 'p'.repeat(128))) <= 250);
  const store = new Store();
  await store.register(ctx, 'child-1', async () => {});
  const otherRoot = join(f.root, 'elsewhere');
  mkdirSync(otherRoot);
  const otherWorkspace = join(otherRoot, f.workspace.split('/').at(-1));
  mkdirSync(otherWorkspace);
  const other = await parentContext(f.runtime, { workspace: otherWorkspace });
  assert.equal(other.directory, ctx.directory);
  await assert.rejects(() => store.status(other, 'child-1'), { code: 'WORKSPACE_COLLISION' });
  await assert.rejects(() => store.register(other, 'child-2', async () => {}), { code: 'WORKSPACE_COLLISION' });
});

test('registry and state have separate ownership, private permissions, immutable terminal state and no diagnostic files', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store();
  await store.register(ctx, 'child-1', async () => {});
  const directory = join(ctx.directory, 'child-1');
  const stateFile = join(directory, 'state.json');
  const indexFile = join(ctx.directory, 'index.json');
  const initialIndex = readFileSync(indexFile, 'utf8');
  assert.deepEqual(JSON.parse(initialIndex), {
    version: 1, workspace: f.workspace, parentSessionId: f.env.PI_SESSION_ID, childSessionIds: ['child-1'],
  });
  for (const path of [ctx.root, ctx.directory, directory]) assert.equal(statSync(path).mode & 0o777, 0o700);
  for (const path of [stateFile, indexFile]) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await store.status(ctx, 'child-1'), { sessionId: 'child-1', state: 'launching' });
  for (const state of ['in_progress', 'waiting_user', 'blocked', 'in_progress', 'completed']) {
    const result = await store.report(ctx.root, ctx.directory, 'child-1', state);
    assert.equal(result.state, state);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { state });
  }
  const inode = statSync(stateFile).ino;
  await store.report(ctx.root, ctx.directory, 'child-1', 'completed');
  assert.equal(statSync(stateFile).ino, inode, 'idempotent reports do not rewrite the file');
  await assert.rejects(() => store.report(ctx.root, ctx.directory, 'child-1', 'in_progress'), { code: 'TERMINAL_STATE' });
  assert.equal(readFileSync(indexFile, 'utf8'), initialIndex, 'report never duplicates state in the parent index');
  assert.deepEqual(readdirSync(directory), ['state.json']);
  await assert.rejects(() => store.register(ctx, 'child-1', async () => {}), { code: 'SESSION_COLLISION' });
  await assert.rejects(() => store.register(ctx, f.env.PI_SESSION_ID, async () => {}), { code: 'SESSION_COLLISION' });
});

test('registration failure rolls back only its unpublished child; missing populated index is not rebuilt', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store();
  await assert.rejects(() => store.register(ctx, 'broken-child', async () => { throw new Error('write failed'); }), /write failed/);
  assert.deepEqual(readdirSync(ctx.directory), []);
  await store.register(ctx, 'good-child', async () => {});
  unlinkSync(join(ctx.directory, 'index.json'));
  await assert.rejects(() => store.register(ctx, 'new-child', async () => {}), { code: 'MISSING_INDEX' });
  assert.equal(existsSync(join(ctx.directory, 'good-child', 'state.json')), true);
  assert.equal(existsSync(join(ctx.directory, 'new-child')), false);
});

test('corrupt or missing state is an error, never an inferred task status or automatic repair', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store();
  await store.register(ctx, 'child-1', async () => {});
  const file = join(ctx.directory, 'child-1', 'state.json');
  for (const content of ['{', '{"state":"unknown"}', '{"state":"completed","report":"not allowed"}', Buffer.from([0xff])]) {
    writeFileSync(file, content);
    await assert.rejects(() => store.status(ctx, 'child-1'));
    await assert.rejects(() => store.report(ctx.root, ctx.directory, 'child-1', 'completed'));
    assert.deepEqual(readFileSync(file), Buffer.from(content));
  }
  unlinkSync(file);
  await assert.rejects(() => store.status(ctx, 'child-1'), { code: 'ENOENT' });
  assert.equal(existsSync(file), false);
});

test('queries do not lock or mutate; orphaned writer locks time out instead of being stolen', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store(30);
  await store.register(ctx, 'child-1', async () => {});
  const lock = join(ctx.directory, 'child-1', '.state.lock');
  mkdirSync(lock);
  assert.equal((await store.status(ctx, 'child-1')).state, 'launching');
  await assert.rejects(() => store.report(ctx.root, ctx.directory, 'child-1', 'completed'), { code: 'STORE_BUSY' });
  assert.equal(existsSync(lock), true);
  rmdirSync(lock);
  await assert.rejects(() => withLock(lock, async () => { throw new Error('operation failure'); }), /operation failure/);
  assert.equal(existsSync(lock), false);
});

test('symlink roots, children and state files cannot redirect state writes', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, ctx.root);
  const store = new Store();
  await assert.rejects(() => store.register(ctx, 'child-1', async () => {}), { code: 'UNSAFE_PATH' });
  assert.deepEqual(readdirSync(outside), []);
  unlinkSync(ctx.root);
  await store.register(ctx, 'child-1', async () => {});
  const child = join(ctx.directory, 'child-1');
  renameSync(child, join(outside, 'child'));
  symlinkSync(join(outside, 'child'), child);
  await assert.rejects(() => store.status(ctx, 'child-1'), { code: 'UNSAFE_PATH' });
  unlinkSync(child);
  renameSync(join(outside, 'child'), child);
  unlinkSync(join(child, 'state.json'));
  const target = join(outside, 'state.json');
  writeFileSync(target, '{"state":"launching"}');
  symlinkSync(target, join(child, 'state.json'));
  await assert.rejects(() => store.report(ctx.root, ctx.directory, 'child-1', 'completed'));
  assert.equal(readFileSync(target, 'utf8'), '{"state":"launching"}');
});

test('reports follow explicit binding, not child cwd; missing, switched and escaped bindings are refused', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  await new Store().register(ctx, 'child-1', async () => {});
  const runtime = f.childRuntime(ctx.directory, 'child-1');
  const bound = await reportBinding(runtime);
  assert.equal(bound.directory, ctx.directory);
  assert.equal(bound.sessionId, 'child-1');
  await assert.rejects(() => reportBinding(f.runtime), { code: 'MISSING_BINDING' });
  await assert.rejects(() => reportBinding({ ...runtime, env: { ...runtime.env, PI_SESSION_ID: 'new-session' } }), { code: 'SESSION_MISMATCH' });
  await assert.rejects(() => reportBinding({ ...runtime, env: { ...runtime.env, PI_WARP_DELEGATE_PARENT_DIR: f.root } }), { code: 'INVALID_BINDING' });
});

test('many processes report concurrently while readers always see complete JSON; the final terminal update wins', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store();
  await store.register(ctx, 'child-1', async () => {});
  const runtime = f.childRuntime(ctx.directory, 'child-1');
  let readers = true;
  const reading = (async () => {
    while (readers) {
      assert.ok(TASK_STATES.includes((await store.status(ctx, 'child-1')).state));
    }
  })();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => runProcess([
    cliPath, 'report', '--state', ['in_progress', 'waiting_user', 'blocked'][i % 3], '--json',
  ], { cwd: f.cwd, env: runtime.env })));
  readers = false;
  await reading;
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  const terminal = await Promise.all(['completed', 'failed', 'cancelled'].map((state) => runProcess([
    cliPath, 'report', '--state', state, '--json',
  ], { cwd: f.cwd, env: runtime.env })));
  assert.equal(terminal.filter((r) => r.code === 0).length, 1);
  assert.equal(terminal.filter((r) => r.code === 1).length, 2);
  assert.ok(isTerminal((await store.status(ctx, 'child-1')).state));
  assert.deepEqual(readdirSync(join(ctx.directory, 'child-1')), ['state.json']);
});

test('invalid parent index schemas are rejected without repairing or adding children', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store();
  await store.register(ctx, 'child-1', async () => {});
  const path = join(ctx.directory, 'index.json');
  const initial = JSON.parse(readFileSync(path, 'utf8'));
  for (const index of [
    { ...initial, version: 2 },
    { ...initial, childSessionIds: ['child-1', 'child-1'] },
    { ...initial, childSessionIds: ['../escape'] },
    { ...initial, states: { 'child-1': 'completed' } },
    { ...initial, parentSessionId: 'different-parent' },
  ]) {
    const text = JSON.stringify(index);
    writeFileSync(path, text);
    await assert.rejects(() => store.status(ctx, 'child-1'), { code: 'CORRUPT_INDEX' });
    await assert.rejects(() => store.register(ctx, 'child-2', async () => {}), { code: 'CORRUPT_INDEX' });
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.equal(existsSync(join(ctx.directory, 'child-2')), false);
  }
});
