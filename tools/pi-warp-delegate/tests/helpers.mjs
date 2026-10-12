import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { defaultRuntime } from '../dist/launch.js';
import { BINDING_PARENT, BINDING_SESSION } from '../dist/context.js';

export const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
export const fixturePath = fileURLToPath(new URL('./fixtures/launch-cli.mjs', import.meta.url));

export function fixture(t, suffix = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-warp-delegate-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, `home${suffix}`);
  const workspace = join(root, `主项目${suffix}`);
  const cwd = join(root, `另一个 worktree${suffix}`);
  const bin = join(root, `bin${suffix}`);
  for (const path of [home, workspace, cwd, bin]) mkdirSync(path);
  const promptFile = join(root, 'task.md');
  writeFileSync(promptFile, '# 原始任务\n请检查代码，不修改无关文件。\n');
  const piPath = join(bin, 'pi');
  writeFileSync(piPath, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const record = {
  argv: args, cwd: process.cwd(), inputTTY: !!process.stdin.isTTY, outputTTY: !!process.stdout.isTTY,
  parent: process.env.${BINDING_PARENT}, child: process.env.${BINDING_SESSION},
  inheritedPiSessionId: process.env.PI_SESSION_ID ?? null,
  inheritedProvider: process.env.PI_PROVIDER ?? null,
  home: process.env.HOME, path: process.env.PATH,
};
if (process.env.TEST_REPORT_ON_START) {
  const id = args[args.indexOf('--session-id') + 1];
  record.report = JSON.parse(cp.execFileSync(process.execPath,
    [process.env.TEST_CLI, 'report', '--state', process.env.TEST_REPORT_ON_START, '--json'],
    { env: { ...process.env, PI_SESSION_ID: id }, encoding: 'utf8' }));
}
fs.writeFileSync(process.env.TEST_PI_RECORD, JSON.stringify(record));
`);
  chmodSync(piPath, 0o700);
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    PI_SESSION_ID: 'parent-session-123', PI_PROVIDER: 'fixture-provider', PI_MODEL: 'fixture-model',
    PI_REASONING_LEVEL: 'high', TEST_PI_RECORD: join(root, 'fake-pi-record.json'), TEST_CLI: cliPath,
  };
  delete env[BINDING_PARENT];
  delete env[BINDING_SESSION];
  const opens = [];
  const runtime = {
    ...defaultRuntime(), home, cwd: workspace, env, platform: 'darwin', cliPath,
    openUri: async (uri) => { opens.push(uri); },
  };
  const options = {
    workspace, cwd, promptFile, name: '修复登录', model: 'fixture-provider/fixture-model', thinking: 'high',
  };
  const args = ['launch', '--workspace', workspace, '--cwd', cwd, '--prompt-file', promptFile,
    '--name', options.name, '--model', options.model, '--thinking', options.thinking, '--json'];
  const childRuntime = (parentDirectory, id) => ({
    ...runtime, cwd,
    env: { ...env, [BINDING_PARENT]: parentDirectory, [BINDING_SESSION]: id, PI_SESSION_ID: id },
  });
  return { root, home, workspace, cwd, bin, promptFile, piPath, env, runtime, options, args, opens, childRuntime };
}

export function runProcess(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Test child timed out')); }, 20_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

export function invoke(args, f, env = f.env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: f.workspace, env, encoding: 'utf8', timeout: 10_000,
  });
}

export function childIdFromUri(uri) {
  return new URL(uri).pathname.slice(1).replace(/^pi_delegate_/, '').replaceAll('_', '-');
}
