import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(projectRoot, 'backend/plugins');
const sdkRoot = resolve(projectRoot, 'packages/plugin-sdk');
const applicationRoots = ['backend/core', 'backend/api', 'backend/db']
  .map((path) => resolve(projectRoot, path));
const findings = [];

function inside(path, root) {
  return path === root || path.startsWith(root + sep);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile() && path.endsWith('.mjs')) files.push(path);
  }
  return files;
}

function importsFrom(source) {
  const specifiers = [];
  const staticImport = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?(['"])([^'"\n]+)\1/g;
  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  }
  return specifiers;
}

function checkImport(file, specifier, layer) {
  const destination = specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
  const report = (problem) => findings.push({
    file: relative(projectRoot, file).replaceAll(sep, '/'), problem,
  });
  if (layer === 'application') {
    if ((destination && inside(destination, pluginRoot))
        || /(?:^|\/)backend\/plugins(?:\/|$)/.test(specifier)) {
      report('application imports a plugin implementation instead of an injected port');
    }
    return;
  }
  if (layer === 'sdk') {
    if ((destination && !inside(destination, sdkRoot))
        || /(?:^|\/)backend(?:\/|$)/.test(specifier)) {
      report('plugin SDK imports application internals');
    }
    return;
  }
  if ((destination && !inside(destination, pluginRoot) && !inside(destination, sdkRoot))
      || /(?:^|\/)backend\/(?:core|api|db|config|server)(?:[/.]|$)/.test(specifier)) {
    report('plugin imports application internals');
    return;
  }
  if (!destination || !inside(destination, pluginRoot)) return;
  const sourceParts = relative(pluginRoot, file).split(sep);
  const targetParts = relative(pluginRoot, destination).split(sep);
  if (sourceParts.length === 1 && targetParts.length > 1) {
    report('generic plugin infrastructure imports a built-in provider');
  } else if (sourceParts.length > 1 && targetParts.length > 1
      && sourceParts[0] !== targetParts[0]) {
    report('provider imports another provider instead of using the host');
  }
}

for (const [directories, layer] of [
  [applicationRoots, 'application'],
  [[pluginRoot], 'plugin'],
  [[sdkRoot], 'sdk'],
]) {
  for (const directory of directories) {
    for (const file of await collectFiles(directory)) {
      for (const specifier of importsFrom(await readFile(file, 'utf8'))) {
        checkImport(file, specifier, layer);
      }
    }
  }
}

if (findings.length) {
  for (const finding of findings) process.stderr.write(`${finding.file}: ${finding.problem}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('core/plugin boundary check passed (application, providers, host and SDK dependencies are separated)\n');
}
