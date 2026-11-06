import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflow = YAML.parse(readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
const appManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const sdkManifest = JSON.parse(readFileSync(path.join(repoRoot, 'packages/plugin-sdk/package.json'), 'utf8'));

assert.deepEqual(workflow.permissions, { contents: 'read' }, 'CI must use only read access to repository contents');
assert.equal(
  appManifest.scripts?.['check:config-template'],
  'node scripts/check-config-template.mjs',
  'the configuration template check must have a stable npm script',
);
assert.ok(
  String(appManifest.scripts?.check || '').includes('scripts/check-config-template.mjs'),
  'npm run check must include the configuration template check',
);

function engineFloor(specification) {
  const match = String(specification || '').match(/^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/);
  assert.ok(match, 'Node engine must declare a simple inclusive minimum version');
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function formatVersion(version) {
  return version.join('.');
}

const appNodeFloor = engineFloor(appManifest.engines?.node);
const sdkNodeFloor = engineFloor(sdkManifest.engines?.node);
assert.deepEqual(sdkNodeFloor, appNodeFloor, 'application and plugin SDK must declare the same Node minimum');

const jobs = workflow.jobs || {};
assert.ok(jobs.check, 'CI must include the full release check job');
assert.ok(jobs['minimum-supported-node'], 'CI must include the minimum Node compatibility job');
assert.ok(jobs['rust-backend'], 'CI must compile the Rust backend workspace');
assert.ok(
  (jobs['rust-backend'].steps || []).some((step) =>
    String(step.run || '').includes('cargo check --workspace --locked')),
  'Rust CI must use the committed Cargo lockfile',
);

const checkoutSteps = Object.entries(jobs).flatMap(([jobName, job]) =>
  (job.steps || [])
    .filter((step) => String(step.uses || '').startsWith('actions/checkout@'))
    .map((step) => ({ jobName, step })));
assert.ok(checkoutSteps.length > 0, 'CI must check out the repository');
for (const { jobName, step } of checkoutSteps) {
  assert.equal(step.with?.['persist-credentials'], false, `${jobName} checkout must not persist its token`);
}

const mainSteps = jobs.check.steps || [];
const mainCommands = new Set(mainSteps.map((step) => String(step.run || '').trim()));
for (const command of [
  'npm audit --audit-level=high',
  'npm run check',
  'npm run check:plugin-sdk',
  'npm run check:licenses',
  'npm test',
  'npm run check:package',
  'npm run check:public-boundary',
  'npm run check:git-history',
  'npm run build',
  'docker build -t drama-warden:ci .',
  'sh scripts/smoke-default-image.sh drama-warden:ci',
]) {
  assert.ok(mainCommands.has(command), `full CI job is missing required release gate: ${command}`);
}

const mainCheckout = mainSteps.find((step) => String(step.uses || '').startsWith('actions/checkout@'));
assert.equal(mainCheckout?.with?.['fetch-depth'], 0, 'full CI job must fetch history for the history boundary scan');

const minimumSteps = jobs['minimum-supported-node'].steps || [];
assert.equal(
  jobs['minimum-supported-node'].services?.mysql?.image,
  'mysql:8.4',
  'minimum Node job must exercise the optional MySQL driver against MySQL 8.4',
);
const setupNode = minimumSteps.find((step) => String(step.uses || '').startsWith('actions/setup-node@'));
assert.equal(
  setupNode?.with?.['node-version'],
  formatVersion(appNodeFloor),
  'minimum Node job must run the exact package engine floor',
);
for (const command of ['npm run check', 'npm run check:plugin-sdk', 'npm test', 'npm run build']) {
  assert.ok(
    minimumSteps.some((step) => String(step.run || '').trim() === command),
    `minimum Node job is missing required compatibility check: ${command}`,
  );
}
const minimumTest = minimumSteps.find((step) => String(step.run || '').trim() === 'npm test');
assert.equal(minimumTest?.env?.RUN_MYSQL_INTEGRATION, '1', 'minimum Node tests must run MySQL integrations');
assert.equal(minimumTest?.env?.MYSQL_HOST, '127.0.0.1', 'minimum Node MySQL tests must use the local service');
assert.equal(minimumTest?.env?.MYSQL_DATABASE, 'drama_warden_test', 'minimum Node MySQL tests must use the test schema');

const startupSmoke = minimumSteps.find((step) => step.name === 'Smoke-test app startup on minimum Node');
assert.ok(startupSmoke, 'minimum Node job must start the application');
assert.ok(
  String(startupSmoke.run || '').includes('node --env-file-if-exists=.env scripts/start.mjs'),
  'minimum Node startup smoke must exercise the production entry command',
);
assert.ok(
  String(startupSmoke.run || '').includes('/api/health'),
  'minimum Node startup smoke must check the health endpoint',
);
assert.ok(
  String(startupSmoke.env?.SQLITE_PATH || '').includes('runner.temp'),
  'minimum Node startup smoke must use a temporary SQLite database',
);
assert.equal(
  startupSmoke.env?.LOCAL_STORAGE_ENABLED,
  'false',
  'minimum Node startup smoke must not require user-configured local storage paths',
);

process.stdout.write('CI release permissions, history scan, release gates and minimum Node coverage are consistent\n');
