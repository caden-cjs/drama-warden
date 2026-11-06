// 夸克网盘官方 Skill CLI 适配器。
// 认证由官方 CLI 管理（OAuth），本模块不会读取或注入 Cookie，也不会直接调用网盘 HTTP API。
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RECYCLE_DIR = "/DramaWarden-Recycle/Quark";
const UNSUPPORTED = "UNSUPPORTED";
const PROCESS_SESSION_ID = `${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;

async function runtimeConfig() {
  // Executable and credential-volume locations are deployment configuration,
  // never writable HTTP settings (an arbitrary CLI path would be code execution).
  return {
    cli: String(process.env.QUARK_CLI_PATH || process.env.QUARK_DRIVE_CLI || "").trim(),
  };
}

// Official FIDs are opaque strings. They may be alphanumeric or contain a
// fingerprint suffix separated by "|"; only path-like/whitespace values are
// rejected here.
function isFid(value) {
  const fid = String(value ?? "");
  return fid.length > 0 && fid.length <= 1024 && !/[\/,\s\0]/.test(fid) && fid !== "." && fid !== "..";
}
let backendKind = null;
let authExpired = false;

export function resetAuthStatus() { authExpired = false; }
export function resetBackendKind() { backendKind = null; }

async function cliPath() {
  const config = await runtimeConfig();
  if (!config.cli) throw new Error("official Quark CLI is not configured (set quark_cli_path or QUARK_CLI_PATH)");
  return config;
}

function markAuthExpired(message) {
  if (!authExpired) {
    authExpired = true;
  }
}

function isAuthError(value) {
  const text = String(value || "");
  return /not_authenticated|unauthoriz|未完成授权|未授权|认证|token.*expir|登录/i.test(text) || [-1408, -1409].includes(Number(value));
}

/** Execute the official CLI and parse its NDJSON stdout. */
export async function runKuake(args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sessionInput = "drama-warden",
  sessionId = PROCESS_SESSION_ID,
  notifyAuthError = true,
} = {}) {
  const config = await cliPath();
  // Keep the historical helper usable by subtitle-worker while translating its
  // two legacy command spellings to the documented official CLI commands.
  let cliArgs = [...args];
  if (cliArgs[0] === "list") {
    if (cliArgs[1] && !isFid(cliArgs[1])) throw new Error("official Quark browse requires a FID, not a path");
    cliArgs = ["browse", ...(cliArgs[1] ? ["--parent-fid", String(cliArgs[1])] : [])];
  } else if (cliArgs[0] === "upload" && cliArgs.length >= 3 && !cliArgs.includes("--parent-fid")) {
    const [command, localPath, parent] = cliArgs;
    if (!isFid(parent)) throw new Error("official Quark upload requires --parent-fid with a FID");
    cliArgs = [command, localPath, "--parent-fid", String(parent)];
  }
  // Never allow a path to leak into FID-only official CLI options.
  for (const option of ["--target-fid", "--parent-fid", "--to-pdir-fid"]) {
    const index = cliArgs.indexOf(option);
    if (index >= 0 && !isFid(cliArgs[index + 1])) {
      throw new Error(`${option} requires a FID, not a path`);
    }
  }
  // Official CLI accepts these optional Agent context arguments. Do not pass secrets.
  if (!cliArgs.includes("--session-input")) cliArgs.push("--session-input", sessionInput);
  if (!cliArgs.includes("--session-id")) cliArgs.push("--session-id", sessionId);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [config.cli, ...cliArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      // Compatibility marker only: the service remains a normal Node process;
      // no Codex runtime is launched or involved in credential handling.
      env: { ...process.env, CODEX_CI: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`official Quark CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => finish(reject, new Error(`official Quark CLI unavailable: ${error.message}`)));
    child.once("close", code => {
      const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const records = [];
      for (const line of lines) {
        try { records.push(JSON.parse(line)); } catch { /* CLI diagnostics are not API data */ }
      }
      const result = [...records].reverse().find(r => r.type === "result") || records.at(-1) || (stdout.trim() ? { _raw: stdout.trim() } : null);
      const codeValue = result?.code;
      if (code !== 0 || (typeof codeValue === "number" && codeValue !== 0)) {
        const detail = result?.msg || stderr.trim() || `exit ${code}`;
        if (notifyAuthError && (isAuthError(codeValue) || isAuthError(detail))) markAuthExpired(detail);
        finish(reject, new Error(`official Quark CLI failed: ${String(detail).slice(0, 500)}`));
        return;
      }
      if (notifyAuthError && result && (isAuthError(result.action) || isAuthError(result.msg))) markAuthExpired(result.msg);
      if (result && typeof result === "object") {
        result._records = records;
        result._lists = records.filter(record => record.type === "list");
        result._artifacts = records.filter(record => record.type === "artifact");
      }
      finish(resolve, result);
    });
  });
}

export async function detectBackend() {
  if (backendKind) return backendKind;
  try { await cliPath(); } catch { backendKind = "none"; return backendKind; }
  backendKind = "official-cli";
  return backendKind;
}

function unwrap(r, operation) {
  if (!r) return null;
  if (r.code < 0) throw new Error(`official Quark ${operation} failed: ${r.msg || r.code}`);
  return r.data ?? r;
}
function itemsFrom(data) {
  if (Array.isArray(data)) return data;
  return data?.list || data?.items || data?.files || data?.file_list || data?.data?.list || data?.data?.items || data?.data?.files || data?.data?.file_list || [];
}
function normalizeItems(items) {
  return items.map(item => {
    const explicitDir = item.isDir ?? item.is_dir ?? item.dir;
    return {
      ...item,
      name: item.name ?? item.filename ?? item.file_name ?? item.fileName ?? "",
      isDir: explicitDir === undefined || explicitDir === null
        ? item.type === "dir" || String(item.file_type ?? "") === "0" || Number(item.category) === 0
        : Boolean(explicitDir),
      fid: item.fid ?? item.file_id ?? item.fileId,
      mtime: item.mtime ?? item.updated_at ?? item.updatedAt,
      size: item.size ?? item.file_size,
    };
  });
}

export async function mkdirChain(fullPath) {
  return ensureDirectoryFid(fullPath);
}

export async function quarkList(targetPath = "/", { limit = 20, recent = false } = {}) {
  if (authExpired) throw new Error("official Quark authorization expired; run the official CLI login");
  const args = ["browse"];
  const parentFid = isFid(targetPath) ? String(targetPath) : await directoryFid(targetPath);
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "drama-warden-quark-browse-"));
  args.push("--parent-fid", parentFid, "--all", "--task-dir", taskDir);
  try {
    const response = await runKuake(args);
    const data = unwrap(response, "browse") || {};
    const artifact = response?._artifacts?.at(-1);
    // The official CLI has two complete-result response shapes: without a
    // task directory it emits a separate `artifact` record; with --task-dir
    // it puts the JSONL path directly on result.data. The bounded file_list
    // preview is never accepted as a substitute for either complete result.
    const artifactPath = artifact?.data?.file_path
      || (data.hasMore === false ? data.file_path : null);
    let rawItems;
    if (artifactPath) {
      const relativePath = path.relative(taskDir, path.resolve(artifactPath));
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error("official Quark Artifact path is outside its task directory");
      }
      rawItems = await readJsonlArtifact(artifactPath);
    } else {
      // `browse --all` promises an Artifact. Falling back to its bounded preview
      // would silently make update/cleanup decisions from incomplete data.
      throw new Error("official Quark browse did not publish its complete result Artifact");
    }
    let files = normalizeItems(rawItems);
    if (recent) files.sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0));
    const total = files.length;
    const effective = limit > 0 ? limit : Infinity;
    const truncated = files.length > effective;
    if (truncated) files = files.slice(0, effective);
    return { path: targetPath, files, total, truncated, recent, previewTotal: Number(data.total ?? total) };
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
}

async function readJsonlArtifact(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("official Quark Artifact path must be absolute");
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("official Quark Artifact is not a file");
  const items = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (item && typeof item === "object") items.push(item);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return items;
}

function unsupported(operation) {
  const error = new Error(`official Quark CLI operation is unsupported: ${operation}`);
  error.code = UNSUPPORTED;
  return error;
}

async function directoryFid(targetPath) {
  if (isFid(targetPath)) return String(targetPath);
  const normalized = path.posix.normalize(String(targetPath || "/"));
  if (normalized === "/") return "0";
  if (!normalized.startsWith("/")) throw new Error(`Quark path must be absolute: ${targetPath}`);
  let parentFid = "0";
  for (const name of normalized.split("/").filter(Boolean)) {
    const listing = await quarkList(parentFid, { limit: 0 });
    const match = listing.files.find(item => item.isDir && item.name === name);
    if (!match || !isFid(match.fid)) throw new Error(`Quark directory not found: ${normalized}`);
    parentFid = String(match.fid);
  }
  return parentFid;
}

export async function quarkDirectoryFid(targetPath) {
  return directoryFid(targetPath);
}

async function ensureDirectoryFid(targetPath) {
  if (isFid(targetPath)) return String(targetPath);
  const normalized = path.posix.normalize(String(targetPath || "/"));
  if (normalized === "/") return "0";
  if (!normalized.startsWith("/")) throw new Error(`Quark path must be absolute: ${targetPath}`);
  let parentFid = "0";
  for (const name of normalized.split("/").filter(Boolean)) {
    const listing = await quarkList(parentFid, { limit: 0 });
    const existing = listing.files.find(item => item.isDir && item.name === name);
    if (existing) {
      if (!isFid(existing.fid)) throw new Error(`Quark directory has an invalid FID: ${name}`);
      parentFid = String(existing.fid);
      continue;
    }
    const created = unwrap(await runKuake(["create-folder", "--dir-path", name, "--parent-fid", parentFid], { timeoutMs: 60_000 }), "create-folder") || {};
    const createdFid = created.fid ?? created.file_id ?? created.fileId;
    if (!isFid(createdFid)) throw new Error(`official Quark create-folder returned no FID for: ${name}`);
    parentFid = String(createdFid);
  }
  return parentFid;
}

async function objectFid(objectPath) {
  if (isFid(objectPath)) return String(objectPath);
  const raw = String(objectPath || "");
  if (!raw.startsWith("/")) throw new Error(`Quark path must be absolute: ${objectPath}`);
  const normalized = path.posix.normalize(raw);
  const parent = path.posix.dirname(normalized) || "/";
  const name = path.posix.basename(normalized);
  const listing = await quarkList(parent, { limit: 0 });
  const match = listing.files.find(item => item.name === name);
  if (!match || !isFid(match.fid)) throw new Error(`Quark object not found: ${normalized}`);
  return String(match.fid);
}

export async function quarkSave(shareUrl, destPath, { fidList = null } = {}) {
  const pwd = extractQuarkPwd(shareUrl);
  const cleanUrl = stripQuarkPwd(shareUrl);
  const args = ["saveas", "--url", cleanUrl];
  if (fidList !== null) {
    if (!Array.isArray(fidList) || fidList.length === 0) {
      throw new Error("official Quark saveas fidList must be a non-empty array");
    }
    const fids = [...new Set(fidList.map(String))];
    if (fids.some(fid => !isFid(fid))) throw new Error("official Quark saveas fidList contains an invalid FID");
    args.push("--fid-list", fids.join(","));
  }
  if (destPath) args.push("--to-pdir-fid", await ensureDirectoryFid(destPath));
  if (pwd) args.push("--passcode", pwd);
  const data = unwrap(await runKuake(args, { timeoutMs: 15 * 60_000 }), "saveas") || {};
  const taskId = data.task_id ?? data.taskId ?? data.save_data?.task_id ?? null;
  const savedCount = data.savedCount ?? data.count ?? data.save_as_sum_num ?? null;
  const verified = Number(data.status) === 2;
  return {
    ok: true,
    savedCount,
    task_id: taskId,
    taskPoll: { completed: verified, status: data.status ?? null, saveAsSumNum: savedCount ?? 0 },
    verified,
    savePath: data.save_path ?? null,
  };
}

/** Read every leaf in a public/private share without saving it. */
export async function quarkShareFiles(shareUrl, { pageSize = 50, maxFiles = 10_000, maxDepth = 10 } = {}) {
  const size = Math.max(1, Math.min(100, Number.parseInt(pageSize, 10) || 50));
  const fileLimit = Math.max(1, Number.parseInt(maxFiles, 10) || 10_000);
  const depthLimit = Math.max(1, Math.min(20, Number.parseInt(maxDepth, 10) || 10));
  const pwd = extractQuarkPwd(shareUrl);
  const cleanUrl = stripQuarkPwd(shareUrl);
  const pending = [{ fid: "0", path: [], depth: 0 }];
  const visitedDirs = new Set(["0"]);
  const files = [];
  let visitedEntries = 0;

  while (pending.length) {
    const dir = pending.shift();
    let page = 1;
    for (;;) {
      if (page > 200) throw new Error("official Quark share listing exceeded 200 pages in one folder");
      const args = ["share-detail", "--url", cleanUrl, "--page", String(page), "--size", String(size), "--pdir-fid", dir.fid];
      if (pwd) args.push("--passcode", pwd);
      const data = unwrap(await runKuake(args, { timeoutMs: 90_000 }), "share-detail") || {};
      const entries = Array.isArray(data.files) ? data.files : [];
      visitedEntries += entries.length;
      if (visitedEntries > fileLimit * 2) {
        throw new Error(`official Quark share exceeds the safe ${fileLimit} file traversal limit`);
      }

      for (const entry of entries) {
        const name = String(entry.filename ?? entry.name ?? "");
        const fid = String(entry.fid ?? "");
        if (!name || !isFid(fid)) throw new Error("official Quark share detail returned an entry without a valid name/FID");
        const isDir = String(entry.file_type ?? "") === "0" || Number(entry.category) === 0;
        if (isDir) {
          if (dir.depth >= depthLimit) throw new Error(`official Quark share exceeds the safe ${depthLimit}-level directory depth`);
          if (!visitedDirs.has(fid)) {
            visitedDirs.add(fid);
            pending.push({ fid, path: [...dir.path, name], depth: dir.depth + 1 });
          }
          continue;
        }
        files.push({
          ...entry,
          fid,
          name,
          size: Number(entry.size ?? 0),
          isDir: false,
          path: dir.path.join("/"),
        });
        if (files.length > fileLimit) {
          throw new Error(`official Quark share exceeds the safe ${fileLimit} file traversal limit`);
        }
      }
      if (entries.length < size) break;
      page++;
    }
  }

  return files;
}

export async function quarkMove(src, dest) {
  const sourceFid = await objectFid(src);
  let targetFid;
  let requestedName = null;
  if (isFid(dest)) {
    targetFid = String(dest);
  } else {
    try {
      // Existing directory path: the common legacy API spelling.
      targetFid = await directoryFid(dest);
    } catch {
      // Non-existing path is interpreted as a full destination filename.
      const destination = path.posix.normalize(String(dest || ""));
      targetFid = await directoryFid(path.posix.dirname(destination) || "/");
      requestedName = path.posix.basename(destination);
    }
  }
  if (!isFid(sourceFid) || !isFid(targetFid)) throw new Error("invalid source or target FID");
  // Official rename is a separately confirmed batch operation. Scheduled
  // automation must not smuggle a rename through the move API.
  if (requestedName && !isFid(src) && path.posix.basename(String(src)) !== requestedName) {
    throw unsupported("move with rename");
  }
  const data = unwrap(await runKuake(["move", sourceFid, "--target-fid", targetFid]), "move");
  return data ?? { ok: true };
}

// 官方 CLI 的 rename 是独立的、批量且需显式确认的操作。
// 事件只传路径和目标名；FID 在服务端临时解析，避免暴露给前端。
export async function quarkRenameBatch(items = []) {
  if (!Array.isArray(items) || !items.length) return { ok: true, renamed: [] };
  const cliItems = [];
  for (const item of items) {
    const oldPath = String(item?.path || "");
    const newName = path.basename(String(item?.newName || ""));
    if (!oldPath || !newName || newName === path.posix.basename(oldPath)) continue;
    const fid = await objectFid(oldPath);
    cliItems.push({
      fid,
      oldName: path.posix.basename(oldPath),
      newName,
    });
  }
  return quarkRenameFids(cliItems);
}

/** Rename already listed FIDs in one official CLI batch; keep its undo record. */
export async function quarkRenameFids(items = []) {
  if (!Array.isArray(items) || !items.length) return { ok: true, renamed: [] };
  const cliItems = items.map(item => ({
    fid: String(item?.fid || ""),
    old_name: String(item?.oldName || ""),
    new_name: String(item?.newName || ""),
  }));
  if (cliItems.some(item => !isFid(item.fid) || !item.old_name || !item.new_name ||
      item.old_name.includes("/") || item.new_name.includes("/"))) {
    throw new Error("invalid Quark rename item");
  }
  if (new Set(cliItems.map(item => item.fid)).size !== cliItems.length) {
    throw new Error("duplicate Quark rename FID");
  }

  // The official CLI places its REVERT record next to the items file. A temp
  // directory removed after the call makes a successful batch impossible to
  // undo, so retain both under the OAuth state volume.
  const recordRoot = process.env.QUARK_RENAME_RECORD_DIR || path.join(
    process.env.QUARK_STATE_DIR || os.tmpdir(), "drama-warden-rename-batches"
  );
  await mkdir(recordRoot, { recursive: true, mode: 0o700 });
  const batchDir = await mkdtemp(path.join(recordRoot, "batch-"));
  const itemsFile = path.join(batchDir, "items.json");
  await writeFile(itemsFile, JSON.stringify({ schema_version: 1, items: cliItems }), { encoding: "utf8", mode: 0o600 });
  const data = unwrap(await runKuake(["rename", "--items-file", itemsFile], { timeoutMs: 120_000 }), "rename") || {};
  const successCount = Number(data.success_count);
  const confirmed = data.result_status === "SUCCESS" &&
    (!Number.isFinite(successCount) || successCount === cliItems.length) &&
    Number(data.fail_count || 0) === 0 && Number(data.pending_count || 0) === 0;
  return { ...data, ok: confirmed, requested: cliItems.length };
}

function recycleBatchPath() {
  const base = path.posix.normalize(String(process.env.QUARK_RECYCLE_DIR || DEFAULT_RECYCLE_DIR));
  if (!base.startsWith("/") || base === "/") throw new Error("QUARK_RECYCLE_DIR must be an absolute non-root path");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const nonce = Math.random().toString(36).slice(2, 8);
  return path.posix.join(base, `${stamp}_${nonce}`);
}

/** Quark deletion is reversible: move the object to a unique recycle folder. */
export async function quarkDelete(targetPath) {
  const source = String(targetPath || "");
  const normalized = isFid(source) ? null : path.posix.normalize(source);
  if (!source || source.split('/').some((part) => part === '.' || part === '..')
      || source.includes('\\') || source.includes('\0')
      || normalized === '/' || normalized === '.' || normalized === '..') {
    throw new Error("refusing to recycle the Quark root");
  }
  const recycleRoot = path.posix.normalize(String(process.env.QUARK_RECYCLE_DIR || DEFAULT_RECYCLE_DIR));
  if (normalized && (!normalized.startsWith("/") || normalized === recycleRoot || normalized.startsWith(`${recycleRoot}/`))) {
    throw new Error("refusing to recycle an object already inside the Quark recycle area");
  }
  const destination = recycleBatchPath();
  await mkdirChain(destination);
  const result = await quarkMove(source, destination);
  return { ok: true, mode: "move-to-recycle", source, recyclePath: destination, result };
}

export async function pollQuarkTask() { throw unsupported("task polling"); }

export async function quarkStatus() {
  const backend = await detectBackend();
  if (backend !== "official-cli") return { ok: false, valid: false, configured: false, backend, error: "official Quark CLI is not configured" };
  try {
    const data = unwrap(await runKuake(["get-user-info"]), "get-user-info") || {};
    const userInfo = data.userInfo ?? data.user_info ?? data;
    const vipInfo = data.vipInfo ?? data.vip_info ?? {};
    authExpired = false;
    return {
      ok: true,
      valid: true,
      configured: true,
      backend,
      username: userInfo.nickname ?? userInfo.username ?? null,
      expiresAt: data.expiresAt ?? data.expireAt ?? vipInfo.expiresIn ?? null,
      vip: vipInfo.vipType ?? data.member_type ?? data.vip_type ?? null,
    };
  } catch (error) {
    const message = String(error.message || error);
    if (isAuthError(message)) markAuthExpired(message);
    return { ok: false, valid: false, configured: true, backend, error: message };
  }
}

function extractQuarkPwd(url) { try { const u = new URL(url); return u.searchParams.get("pwd") || (u.hash.match(/pwd=([^&]+)/) || [])[1] || ""; } catch { return ""; } }
function stripQuarkPwd(url) { try { const u = new URL(url); u.searchParams.delete("pwd"); u.hash = u.hash.replace(/[#&]?pwd=[^&]+/, ""); return u.toString(); } catch { return url; } }
