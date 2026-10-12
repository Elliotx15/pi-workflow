// Test-only dependency injection. Never invoke /usr/bin/open or a real Pi.
import { appendFileSync } from 'node:fs';
import { runCli } from '../../dist/app.js';
import { BINDING_PARENT, BINDING_SESSION, parentContext } from '../../dist/context.js';
import { defaultRuntime } from '../../dist/launch.js';

const runtime = defaultRuntime();
runtime.platform = 'darwin';
runtime.openUri = async (uri) => {
  if (process.env.TEST_OPEN_LOG) appendFileSync(process.env.TEST_OPEN_LOG, `${uri}\n`);
  if (process.env.TEST_OPEN_REPORT) {
    const index = process.argv.indexOf('--workspace');
    const parent = await parentContext(runtime, { workspace: index < 0 ? undefined : process.argv[index + 1] });
    const id = new URL(uri).pathname.slice(1).replace(/^pi_delegate_/, '').replaceAll('_', '-');
    const response = await runCli(['report', '--state', process.env.TEST_OPEN_REPORT, '--json'], {
      ...runtime,
      env: { ...runtime.env, [BINDING_PARENT]: parent.directory, [BINDING_SESSION]: id, PI_SESSION_ID: id },
    });
    if (response.exitCode) throw new Error(response.stderr);
  }
  if (process.env.TEST_OPEN_FAIL) throw new Error('simulated open error');
};
const response = await runCli(process.argv.slice(2), runtime);
process.stdout.write(response.stdout);
process.stderr.write(response.stderr);
process.exitCode = response.exitCode;
