import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.cwd());
const scannerPath = fileURLToPath(new URL('./check-public-boundary.mjs', import.meta.url));
const maxBuffer = 256 * 1024 * 1024;

function runGit(args, { encoding = 'utf8', input } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding,
    input,
    maxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || `git ${args[0]} failed`);
  }
  return result.stdout;
}

function isGeneratedArtifact(path) {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  return segments.includes('.git')
    || segments.includes('node_modules')
    || normalized === 'dist'
    || normalized.startsWith('dist/')
    || normalized === 'coverage'
    || normalized.startsWith('coverage/')
    || normalized === 'frontend/dist'
    || normalized.startsWith('frontend/dist/');
}

function parseTree(rawTree) {
  const entries = [];
  const findings = [];
  let offset = 0;
  while (offset < rawTree.length) {
    const end = rawTree.indexOf(0, offset);
    if (end < 0) throw new Error('git ls-tree returned an invalid NUL-delimited tree');
    const record = rawTree.subarray(offset, end);
    offset = end + 1;
    const separator = record.indexOf(9);
    if (separator < 0) throw new Error('git ls-tree returned an invalid tree record');

    const fields = record.subarray(0, separator).toString('ascii').trim().split(/\s+/);
    const [mode, type, objectId, sizeText] = fields;
    const pathBytes = record.subarray(separator + 1);
    const path = pathBytes.toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) {
      findings.push({ path: pathBytes.toString('hex'), problem: 'non-UTF-8 path requires manual review' });
      continue;
    }
    if (isGeneratedArtifact(path)) {
      findings.push({ path, problem: 'generated or dependency artifact must not be committed' });
      continue;
    }

    const segments = path.replaceAll('\\', '/').split('/');
    if (path.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      findings.push({ path, problem: 'unsafe tracked path' });
      continue;
    }
    if (type !== 'blob') {
      findings.push({ path, problem: 'submodule or non-blob entry requires manual review' });
      continue;
    }
    if (mode === '120000') {
      findings.push({ path, problem: 'local filesystem artifact' });
      continue;
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      findings.push({ path, problem: 'invalid Git blob size' });
      continue;
    }
    if (size > 8 * 1024 * 1024) {
      findings.push({ path, problem: 'large file requires manual review' });
      continue;
    }
    entries.push({ objectId, path, size, mode });
  }
  return { entries, findings };
}

function parseBlobs(rawBlobs, entries) {
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = rawBlobs.indexOf(10, offset);
    if (headerEnd < 0) throw new Error('git cat-file returned an invalid blob header');
    const [objectId, type, sizeText] = rawBlobs.subarray(offset, headerEnd).toString('ascii').split(' ');
    if (objectId !== entry.objectId || type !== 'blob' || Number(sizeText) !== entry.size) {
      throw new Error('git cat-file returned an unexpected blob');
    }
    const start = headerEnd + 1;
    const end = start + entry.size;
    if (end >= rawBlobs.length || rawBlobs[end] !== 10) {
      throw new Error('git cat-file returned a truncated blob');
    }
    blobs.push(rawBlobs.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

const headResult = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
});
if (headResult.error) throw headResult.error;
if (headResult.status !== 0 && headResult.status !== 1) {
  throw new Error(headResult.stderr || 'could not resolve HEAD');
}
const revisions = ['--all'];
if (headResult.status === 0) revisions.push(headResult.stdout.trim());
const commits = runGit(['rev-list', '--reverse', ...revisions]).split(/\r?\n/).filter(Boolean);
if (commits.length === 0) {
  process.stdout.write('Git history scan skipped (no commits exist yet)\n');
} else {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'drama-warden-history-'));
  let scanned = 0;
  try {
    for (const [index, commit] of commits.entries()) {
      const { entries, findings } = parseTree(runGit(
        ['ls-tree', '-r', '-l', '-z', '--full-tree', commit],
        { encoding: null },
      ));
      if (findings.length) {
        process.stderr.write(`public boundary findings in commit ${commit}\n`);
        for (const finding of findings) {
          process.stderr.write(`${finding.path}: ${finding.problem}\n`);
        }
        process.exitCode = 1;
        break;
      }

      const snapshot = join(temporaryRoot, String(index));
      await mkdir(snapshot);
      if (entries.length) {
        const requests = Buffer.from(entries.map((entry) => entry.objectId).join('\n') + '\n');
        const blobs = parseBlobs(runGit(['cat-file', '--batch'], {
          encoding: null,
          input: requests,
        }), entries);
        for (const [entryIndex, entry] of entries.entries()) {
          const targetPath = join(snapshot, ...entry.path.split('/'));
          await mkdir(dirname(targetPath), { recursive: true });
          await writeFile(targetPath, blobs[entryIndex], {
            mode: entry.mode === '100755' ? 0o755 : 0o644,
          });
        }
      }

      const scan = spawnSync(process.execPath, [scannerPath], {
        cwd: snapshot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (scan.error) throw scan.error;
      if (scan.status !== 0) {
        process.stderr.write(`public boundary findings in commit ${commit}\n`);
        process.stderr.write(scan.stderr || scan.stdout || 'boundary scan failed\n');
        process.exitCode = 1;
        break;
      }
      scanned += 1;
      await rm(snapshot, { recursive: true, force: true });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  if (process.exitCode !== 1) {
    process.stdout.write(`Git history boundary scan passed (${scanned} commits)\n`);
  }
}
