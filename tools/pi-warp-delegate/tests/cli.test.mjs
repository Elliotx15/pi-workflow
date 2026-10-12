import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../dist/app.js';
import { parentContext } from '../dist/context.js';
import { Store } from '../dist/storage.js';
import { cliPath, fixture, fixturePath, invoke, runProcess } from './helpers.mjs';

const output = (result) => JSON.parse(result.stdout);

test('help is a complete model-facing workflow without any installation or writes', async (t) => {
  const f = fixture(t);
  for (const args of [[], ['--help'], ['launch', '--help'], ['status', '-h'], ['report', '--help']]) {
    const result = await runCli(args, f.runtime);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /USER choices/);
    assert.match(result.stdout, /LAST ACCEPTED REPORT/);
    assert.match(result.stdout, /does not schedule/);
  }
  const machine = await runCli(['--help', '--json'], f.runtime);
  assert.match(output(machine).help, /PI_WARP_DELEGATE_PARENT_DIR/);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(f.opens, []);
});

test('missing model/thinking returns real main configuration without copying defaults or touching the filesystem', async (t) => {
  const f = fixture(t);
  const base = ['launch', '--cwd', f.cwd, '--prompt-file', f.promptFile, '--name', 'task', '--json'];
  const response = await runCli(base, f.runtime);
  assert.equal(response.exitCode, 0);
  assert.equal(output(response).action, 'needs_input');
  assert.deepEqual(output(response).missing, ['model', 'thinking']);
  assert.deepEqual(output(response).currentMainSession, { model: 'fixture-provider/fixture-model', thinking: 'high' });
  assert.deepEqual(output(response).provided, {});
  const partial = output(await runCli([...base, '--thinking', 'off', '--dry-run'], f.runtime));
  assert.deepEqual(partial.missing, ['model']);
  assert.deepEqual(partial.provided, { thinking: 'off' });
  const ordinary = output(await runCli(base, { ...f.runtime, env: {} }));
  assert.deepEqual(ordinary.currentMainSession, { model: null, thinking: null });
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(f.opens, []);
  assert.equal(existsSync(f.env.TEST_PI_RECORD), false);
});

test('dry-run validates and previews a new session but executes no Pi/open and persists nothing', async (t) => {
  const f = fixture(t);
  const response = await runCli([...f.args, '--dry-run', '--new-window'], f.runtime);
  assert.equal(response.exitCode, 0, response.stderr);
  const plan = output(response);
  assert.equal(plan.action, 'dry_run');
  assert.equal(plan.persisted, false);
  assert.ok(plan.plannedSessionId);
  assert.equal(plan.model, f.options.model);
  assert.equal(plan.thinking, 'high');
  assert.match(plan.warpUri, /\?new_window=true$/);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(f.opens, []);
  assert.equal(existsSync(f.env.TEST_PI_RECORD), false);
});

for (const args of [
  ['result', 'id', '--json'], ['status', '../escape', '--json'], ['status', '--json'],
  ['report', '--state', 'launching', '--json'], ['report', '--state', 'done', '--json'],
  ['report', '--state', 'completed', '--report-file', '/tmp/body', '--json'],
  ['report', '--state', 'completed', '--session-id', 'other', '--json'],
  ['report', '--state', 'completed', '--state', 'failed', '--json'],
  ['launch', '--json'], ['status', 'id', 'extra', '--json'],
]) {
  test(`invalid arguments: ${args.join(' ')}`, async (t) => {
    const f = fixture(t);
    const response = await runCli(args, f.runtime);
    assert.equal(response.exitCode, 2);
    assert.equal(output(response).error.code, 'INVALID_ARGUMENT');
    assert.ok(response.stderr);
    assert.deepEqual(readdirSync(f.home), []);
  });
}

test('preflight rejects nonexistent paths, invalid UTF-8, invalid thinking and missing parent identity without creating state', async (t) => {
  const f = fixture(t);
  const invalid = [
    f.args.map((arg) => arg === f.cwd ? join(f.root, 'absent') : arg),
    f.args.map((arg) => arg === 'high' ? 'ultra' : arg),
    f.args.map((arg) => arg === f.promptFile ? f.cwd : arg),
  ];
  for (const args of invalid) assert.notEqual((await runCli(args, f.runtime)).exitCode, 0);
  const noParent = { ...f.runtime, env: { ...f.env, PI_SESSION_ID: undefined } };
  assert.equal((await runCli(f.args, noParent)).exitCode, 2);
  writeFileSync(f.promptFile, Buffer.from([0xff, 0xfe]));
  assert.equal((await runCli(f.args, f.runtime)).exitCode, 2);
  writeFileSync(f.promptFile, '   ');
  assert.equal((await runCli(f.args, f.runtime)).exitCode, 2);
  assert.deepEqual(readdirSync(f.home), []);
});

test('status is scoped to parent, not child cwd, and querying failed is a successful CLI operation', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store();
  await store.register(ctx, 'child-1', async () => {});
  await store.report(ctx.root, ctx.directory, 'child-1', 'failed');
  const result = invoke(['status', 'child-1', '--json'], f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output(result), { sessionId: 'child-1', state: 'failed' });
  assert.equal(result.stderr, '');
  const other = { ...f.runtime, cwd: f.cwd, env: {} };
  const explicit = await runCli(['status', 'child-1', '--workspace', f.workspace,
    '--parent-session-id', f.env.PI_SESSION_ID, '--json'], other);
  assert.equal(explicit.exitCode, 0, explicit.stderr);
  assert.deepEqual(output(explicit), output(result));
  assert.equal((await runCli(['status', 'child-1', '--json'], other)).exitCode, 2);
});

test('concurrent real CLI processes register distinct children without losing parent index entries', async (t) => {
  const f = fixture(t);
  const log = join(f.root, 'open.log');
  const responses = await Promise.all(Array.from({ length: 10 }, () => runProcess([fixturePath, ...f.args], {
    cwd: f.workspace, env: { ...f.env, TEST_OPEN_LOG: log },
  })));
  for (const response of responses) assert.equal(response.code, 0, response.stderr);
  const ids = responses.map((response) => output(response).sessionId);
  assert.equal(new Set(ids).size, 10);
  const ctx = await parentContext(f.runtime, {});
  const index = JSON.parse(readFileSync(join(ctx.directory, 'index.json'), 'utf8'));
  assert.deepEqual([...index.childSessionIds].sort(), [...ids].sort());
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 10);
  for (const id of ids) assert.equal((await new Store().status(ctx, id)).state, 'launching');
  assert.equal(existsSync(f.env.TEST_PI_RECORD), false, 'the fake opener never executed any Pi');
});

for (const openFails of [false, true]) {
  test(`a fast child report is never overwritten, even when open ${openFails ? 'fails' : 'succeeds'}`, async (t) => {
    const f = fixture(t);
    const response = await runProcess([fixturePath, ...f.args], {
      cwd: f.workspace, env: { ...f.env, TEST_OPEN_REPORT: 'completed', TEST_OPEN_FAIL: openFails ? '1' : '' },
    });
    assert.equal(response.code, openFails ? 1 : 0, response.stderr);
    const body = output(response);
    const id = openFails ? body.error.sessionId : body.sessionId;
    if (openFails) assert.equal(body.error.code, 'OPEN_FAILED');
    else assert.equal(body.action, 'launch_requested');
    const ctx = await parentContext(f.runtime, {});
    assert.equal((await new Store().status(ctx, id)).state, 'completed');
    assert.equal(existsSync(join(ctx.directory, id, 'launch.sh')), true);
    assert.equal(readdirSync(join(f.home, '.warp', 'tab_configs')).length, 1);
  });
}

test('open failure does not infer task failure or retry; no report leaves launching indefinitely', async (t) => {
  const f = fixture(t);
  const log = join(f.root, 'open.log');
  const response = await runProcess([fixturePath, ...f.args], {
    cwd: f.workspace, env: { ...f.env, TEST_OPEN_FAIL: '1', TEST_OPEN_LOG: log },
  });
  assert.equal(response.code, 1);
  const id = output(response).error.sessionId;
  const ctx = await parentContext(f.runtime, {});
  assert.equal((await new Store().status(ctx, id)).state, 'launching');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('unwritable/non-directory storage errors remain CLI errors, not invented task states', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, '.pi-warp-delegate'), 'not a directory');
  const result = await runCli(f.args, f.runtime);
  assert.equal(result.exitCode, 1);
  assert.equal(output(result).error.code, 'UNSAFE_PATH');
  assert.equal('state' in output(result), false);
  assert.deepEqual(f.opens, []);
});

test('the built executable bin works without installation and reports the package version', (t) => {
  const f = fixture(t);
  const result = spawnSync(cliPath, ['--version', '--json'], {
    cwd: f.workspace, env: f.env, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 0, String(result.error ?? result.stderr));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(output(result), { name: pkg.name, version: pkg.version });
  assert.deepEqual(readdirSync(f.home), []);
});

test('child CLI accepts only its bound state updates and exposes immutable-terminal errors', async (t) => {
  const f = fixture(t);
  const ctx = await parentContext(f.runtime, {});
  const store = new Store();
  await store.register(ctx, 'child-1', async () => {});
  const child = f.childRuntime(ctx.directory, 'child-1');
  const call = async (state, runtime = child) => runCli(['report', '--state', state, '--json'], runtime);
  assert.equal((await call('in_progress', f.runtime)).exitCode, 1, 'main Pi cannot report for the child');
  assert.equal((await call('in_progress', { ...child, env: { ...child.env, PI_SESSION_ID: 'other-child' } })).exitCode, 1);
  assert.equal((await call('completed')).exitCode, 0);
  assert.equal((await call('completed')).exitCode, 0);
  const rejected = await call('in_progress');
  assert.equal(rejected.exitCode, 1);
  assert.equal(output(rejected).error.code, 'TERMINAL_STATE');
  assert.equal(output(rejected).error.currentState, 'completed');
  assert.equal((await store.status(ctx, 'child-1')).state, 'completed');
  const absent = await runCli(['status', 'missing-child', '--json'], f.runtime);
  assert.equal(absent.exitCode, 1);
  assert.equal(output(absent).error.code, 'NOT_REGISTERED');
  assert.equal('state' in output(absent), false);
});

test('startup preparation failure never publishes the child or removes pre-existing Warp data', async (t) => {
  const f = fixture(t);
  const warpPath = join(f.home, '.warp');
  writeFileSync(warpPath, 'preserve this existing file');
  const result = await runCli(f.args, f.runtime);
  assert.equal(result.exitCode, 1);
  assert.equal(output(result).error.code, 'UNSAFE_PATH');
  const ctx = await parentContext(f.runtime, {});
  assert.deepEqual(readdirSync(ctx.directory), [], 'no half-published index or child survives');
  assert.equal(readFileSync(warpPath, 'utf8'), 'preserve this existing file');
  assert.deepEqual(f.opens, []);
});
