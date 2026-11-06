import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function environmentKeys(template) {
  const keys = new Set();
  for (const line of template.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match) continue;
    assert.ok(!keys.has(match[1]), `.env.example contains duplicate ${match[1]}`);
    keys.add(match[1]);
  }
  return keys;
}

function composeEnvironmentKeys(compose) {
  return new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/g)]
    .map((match) => match[1]));
}

function configuredEnvironmentKeys(configurationSource) {
  const start = configurationSource.indexOf('function applyConfiguration(');
  const end = configurationSource.indexOf('\nexport function loadConfiguration', start);
  assert.ok(start >= 0 && end > start, 'configuration environment mapping was not found');
  const mapping = configurationSource.slice(start, end);
  return new Set([...mapping.matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)]
    .map((match) => match[1]));
}

function sourceFiles(directory) {
  const absoluteDirectory = path.join(repoRoot, directory);
  return readdirSync(absoluteDirectory).flatMap((name) => {
    if (directory === 'backend' && name === 'tests') return [];
    const relativePath = path.join(directory, name);
    const absolutePath = path.join(repoRoot, relativePath);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) return sourceFiles(relativePath);
    return relativePath.endsWith('.mjs') ? [relativePath] : [];
  });
}

function referencedEnvironmentKeys() {
  const keys = new Set();
  const pattern = /(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g;
  for (const relativePath of [...sourceFiles('backend'), ...sourceFiles('scripts')]) {
    const source = read(relativePath);
    for (const match of source.matchAll(pattern)) keys.add(match[1]);
  }
  return keys;
}

const template = read('.env.example');
const templateKeys = environmentKeys(template);
const composeKeys = composeEnvironmentKeys(read('docker-compose.yml'));
const configuredKeys = configuredEnvironmentKeys(read('backend/config.mjs'));
const unmappedComposeKeys = [...composeKeys]
  .filter((key) => !templateKeys.has(key) && !configuredKeys.has(key))
  .sort();
assert.deepEqual(
  unmappedComposeKeys,
  [],
  'every Docker Compose variable must be in .env.example or map to config/config.example.yaml',
);

const sensitiveKeyPattern = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|WEBHOOK_URL|WEBHOOK_SECRET|WEBHOOK_TOKEN|PASSWORD|COOKIE|SECRET)$/;
const sensitiveKeys = new Set([...composeKeys, ...referencedEnvironmentKeys()]
  .filter((key) => sensitiveKeyPattern.test(key)));
const missingSensitiveKeys = [...sensitiveKeys]
  .filter((key) => !templateKeys.has(key))
  .sort();
assert.deepEqual(
  missingSensitiveKeys,
  [],
  'credentials read by the application must have a named entry in .env.example',
);

assert.ok(template.includes('DRAMA_WARDEN_PLUGIN_<PLUGIN_ID>_<FIELD_KEY>'),
  '.env.example must document the external plugin credential prefix');

process.stdout.write(
  `configuration template check passed (${composeKeys.size} Compose variables; ${sensitiveKeys.size} credential variables)\n`,
);
