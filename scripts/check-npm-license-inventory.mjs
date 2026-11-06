import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const lockPath = resolve(root, 'package-lock.json');
const inventoryPath = resolve(root, 'third-party/npm-license-inventory.json');
const args = process.argv.slice(2);

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function licenseText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') return JSON.stringify(stableJson(value));
  return '';
}

function createInventory(lock) {
  if (!lock || typeof lock !== 'object' || lock.lockfileVersion < 2
      || !lock.packages || typeof lock.packages !== 'object') {
    throw new TypeError('unsupported npm lockfile format');
  }
  const packages = {};
  const missing = [];
  for (const [path, metadata] of Object.entries(lock.packages).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    if (!path || metadata?.link) continue;
    const license = licenseText(metadata.license);
    if (!metadata.version || !license) {
      missing.push(path);
      continue;
    }
    packages[path] = { version: metadata.version, license };
  }
  if (missing.length) {
    throw new Error('npm lockfile packages missing version or license metadata: ' + missing.join(', '));
  }
  return { formatVersion: 1, packages };
}

function compareInventories(expected, current) {
  const differences = [];
  const paths = new Set([...Object.keys(expected.packages), ...Object.keys(current.packages)]);
  for (const path of [...paths].sort()) {
    const before = expected.packages[path];
    const after = current.packages[path];
    if (!before) differences.push(`added ${path}: ${JSON.stringify(after)}`);
    else if (!after) differences.push(`removed ${path}: ${JSON.stringify(before)}`);
    else if (before.version !== after.version || before.license !== after.license) {
      differences.push(`changed ${path}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
  }
  return differences;
}

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const current = createInventory(lock);
if (args.length === 1 && args[0] === '--write-baseline') {
  await writeFile(inventoryPath, JSON.stringify(current, null, 2) + '\n', { mode: 0o644 });
  process.stdout.write(`npm license inventory recorded (${Object.keys(current.packages).length} packages)\n`);
} else if (args.length) {
  throw new TypeError('usage: node scripts/check-npm-license-inventory.mjs [--write-baseline]');
} else {
  const expected = JSON.parse(await readFile(inventoryPath, 'utf8'));
  if (expected.formatVersion !== 1 || !expected.packages || typeof expected.packages !== 'object') {
    throw new TypeError('unsupported npm license inventory format');
  }
  const differences = compareInventories(expected, current);
  if (differences.length) {
    process.stderr.write('npm dependency license inventory changed; review upstream package licenses and update the checked-in inventory:\n');
    for (const difference of differences) process.stderr.write(difference + '\n');
    process.exitCode = 1;
  } else {
    const licenses = [...new Set(Object.values(current.packages).map((item) => item.license))].sort();
    process.stdout.write(`npm license inventory passed (${Object.keys(current.packages).length} packages; ${licenses.join(', ')})\n`);
  }
}
