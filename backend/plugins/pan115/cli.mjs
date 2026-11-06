// 115 网盘文件操作客户端
// 走 115cli(Python, pip install 115cli)— 最新版(v0.7+)真实子命令如下:
//   115cli login cookie "UID=xxx;CID=xxx;SEID=xxx;KID=xxx"
//   115cli account                          → 用户信息
//   115cli ls <path> [-l]                   → 列目录
//   115cli mv <src> <dest>                  → 移动
//   115cli rm [-r] <path>                   → 删除(-r 递归)
//   115cli share save <url> [--dest <dir>]  → 转存(URL 自带 ?password= 也认)
//   115cli mkdir <path>                     → 建子目录
//
// 115 分享链接形如 https://115.com/s/xxx?password=yyy
// 115cli 原生认 URL 上的 ?password=,无需我们拆,这里照样拆(双保险)。

import { spawn } from "node:child_process";
import path from "node:path";

const PAN115_USER = process.env.PAN115_USER || "";

function cliPath() {
  return String(process.env.PAN115_CLI_PATH || "115cli").trim() || "115cli";
}

export function validatePan115Cookie(cookie) {
  const value = String(cookie || "").trim()
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("115 Cookie 格式无效")
  }
  const fields = new Set(value.split(";").map(part => {
    const separator = part.indexOf("=")
    return separator < 0 ? "" : part.slice(0, separator).trim().toUpperCase()
  }))
  if (["UID", "CID", "SEID", "KID"].some(name => !fields.has(name))) {
    throw new Error("115 Cookie 缺少必要字段")
  }
  return value
}

// ── 全局限流器: 115 有阿里云 WAF, 连续快速调用会触发封锁(WAFBlockedError) ──
// 所有 115cli 调用都走这里, 全局串行 + 最小间隔 + WAF 自适应冷却自动重试。
const MIN_INTERVAL_MS = parseInt(process.env.PAN115_MIN_INTERVAL_MS || "3000", 10); // 两次调用最小间隔
const WAF_BASE_COOLDOWN_MS = parseInt(process.env.PAN115_WAF_COOLDOWN_MS || "300000", 10); // WAF 基础冷却 5min
const WAF_MAX_COOLDOWN_MS = 30 * 60 * 1000; // 冷却封顶 30min
let lastCallAt = 0;     // 上次调用完成时间戳
let wafUntil = 0;       // WAF 冷却截止时间戳(0=未冷却)
let wafLevel = 0;       // WAF 连续触发次数(用于递增冷却)
let activeChain = null; // 全局串行链尾

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function isWafError(e) {
  // 优先看完整 stderr(115cli traceback 末尾才有 WAFBlockedError 字样)
  const src = String(e?.stderr || e?.message || e);
  return /WAF|blocked/i.test(src);
}

// 包装一个原始执行函数, 返回限流后的版本(全局互斥 + 最小间隔 + WAF 冷却重试)
function throttleExec(fn) {
  const exec = async (args, opts) => {
    // 等待上次调用完成后的最小间隔
    const sinceLast = Date.now() - lastCallAt;
    if (sinceLast < MIN_INTERVAL_MS) await wait(MIN_INTERVAL_MS - sinceLast);
    // 若处于 WAF 冷却期, 排队等待冷却结束(不抛错, 让调用方无感)
    while (wafUntil > Date.now()) await wait(wafUntil - Date.now());
    let attempt = 0;
    while (true) {
      try {
        const r = await fn(args, opts);
        lastCallAt = Date.now();
        return r;
      } catch (e) {
        if (!isWafError(e)) { lastCallAt = Date.now(); throw e; }
        // WAF 触发: 递增冷却(5/15/30min), 冷却后自动重试
        wafLevel = Math.min(wafLevel + 1, 3);
        const cooldown = Math.min(WAF_BASE_COOLDOWN_MS * Math.pow(2, wafLevel - 1), WAF_MAX_COOLDOWN_MS);
        wafUntil = Date.now() + cooldown;
        console.error(`[pan115] WAF blocked, cooling ${Math.round(cooldown / 1000)}s (level ${wafLevel})...`);
        await wait(cooldown + 1000);
        wafUntil = 0;
        attempt++;
        if (attempt >= 3) { lastCallAt = Date.now(); throw e; }
      }
    }
  };
  return (args, opts) => {
    const run = () => exec(args, opts);
    const p = activeChain ? activeChain.then(run, run) : run();
    activeChain = p.catch(() => {}); // 串行链不断
    return p;
  };
}

// ── spawn 包装 ──────────────────────────────────────
function rawRun115cli(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cliPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("115cli timeout")); }, timeoutMs);
    p.stdout.on("data", c => out += c);
    p.stderr.on("data", c => err += c);
    p.on("error", e => { clearTimeout(t); reject(e); });
    p.on("exit", code => {
      clearTimeout(t);
      if (code !== 0) {
        const e = new Error(`115cli exit ${code}: ${err.slice(0, 500) || out.slice(0, 500)}`);
        e.stderr = err; // 完整 stderr, 供 WAF 检测(截断 500 会丢掉末尾的 WAFBlockedError)
        return reject(e);
      }
      const text = out.trim();
      if (!text) return resolve(null);
      // 115cli ls 输出是纯文本表格;非 ls 多数也是结构化输出
      try { resolve(JSON.parse(text)); }
      catch { resolve({ _raw: text }); }
    });
  });
}

// 限流版: 全局串行 + 最小间隔 + WAF 冷却自动重试
const run115cli = throttleExec(rawRun115cli);

// 探测 CLI 是否可用
let cliAvailable = null;
export async function isAvailable() {
  if (cliAvailable != null) return cliAvailable;
  await new Promise((resolve) => {
    const p = spawn(cliPath(), ["--version"], { stdio: "ignore" });
    p.on("error", () => { cliAvailable = false; resolve(); });
    p.on("exit", (code) => { cliAvailable = code === 0; resolve(); });
  });
  return cliAvailable;
}

// 已知视频/字幕/图片/压缩包扩展名(用于修正 115cli 误把文件标 dir 的问题)
const FILE_EXTS = new Set([
  // 视频
  "mkv", "mp4", "ts", "m2ts", "avi", "rmvb", "wmv", "flv", "mov", "webm", "iso",
  // 音频
  "mp3", "flac", "ape", "wav", "m4a", "ogg", "aac", "dts",
  // 字幕
  "srt", "ass", "ssa", "sub", "idx", "sup",
  // 图片
  "jpg", "jpeg", "png", "gif", "webp", "bmp",
  // 压缩包
  "zip", "rar", "7z", "tar", "gz",
  // 文档
  "pdf", "txt", "nfo", "doc", "docx",
]);

function looksLikeFile(name) {
  // 从 name 末尾提取扩展名(name 可能含 `.` 的中点,如 "S05E01.1080p.mkv")
  const m = (name || "").match(/\.([a-z0-9]+)$/i);
  return !!(m && FILE_EXTS.has(m[1].toLowerCase()));
}

// 解析 ls 文本输出为结构化数组
// 115cli 0.3.x -l 长格式(实测 2026-06-22):
//   "name  type  size  YYYY-MM-DD HH:MM  fid"
// 真实样本(注意 115cli 把所有 .mkv 标 dir 且 name 末尾加 /,需要扩展名修正):
//   "[Dynamis One] 凡人修仙传 - 135 (...).mkv/  dir  -  2025-09-29 08:07  3173699297411648325"
// 列用 2+ 空格分隔,size 列常见 "-" 表示未知,
// mtime 是本地时间(无时区标记) — 由容器 TZ 决定,需要在 docker-compose.yml 设 TZ=Asia/Shanghai
// fid 是 19 位数字(列尾)
function parseLsText(text) {
  if (!text) return [];
  return text.split("\n").map(l => l.trimEnd()).filter(Boolean).map(line => {
    // 2+ 空格分隔
    const parts = line.split(/\s{2,}/);
    const name = (parts[0] || "").trim();
    const type = (parts[1] || "").trim().toLowerCase();  // "dir" / "file"
    const sizeStr = (parts[2] || "").trim();
    const mtimeStr = (parts[3] || "").trim();            // "2025-09-29 08:07"
    const fid = (parts[4] || "").trim();

    // 末尾 "/" 也视为目录(115cli 行为:name 后带 / 通常是目录)
    // 但 115cli 误把所有文件也加 /, 用扩展名二次校正
    const taggedAsDir = type === "dir" || name.endsWith("/");
    const cleanName = name.replace(/\/$/, "");
    const isDir = taggedAsDir && !looksLikeFile(cleanName);

    // size:"-" 或空 → 0
    const size = sizeStr && sizeStr !== "-" ? Number(sizeStr) || 0 : 0;

    // mtime 解析:由容器 TZ 决定语义,这里不预设 UTC+8
    // 上层 cloud-mtime.mjs 收到的就是秒级时间戳
    let mtime = 0;
    if (mtimeStr) {
      const m = mtimeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
      if (m) {
        const [, y, mo, d, h, mi, s = "0"] = m;
        // 直接 new Date(...):用容器本地时区解析(需要 TZ=Asia/Shanghai)
        const localMs = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
        mtime = Math.floor(localMs / 1000);
      }
    }

    return { name: cleanName, isDir, size, mtime, fid };
  });
}

// ── list ─────────────────────────────────────────────
// 115cli ls <path> -l --sort modified --desc
// 取前 limit 条(默认 20,recent=true 时按 mtime 倒序)
export async function pan115List(targetPath = "/", { limit = 20, recent = false } = {}) {
  if (!(await isAvailable())) throw new Error("115cli not installed");
  try {
    const args = ["ls", targetPath, "-l"];
    if (recent) {
      args.push("--sort", "modified", "--desc");
    } else {
      args.push("--sort", "name");
    }
    // 115cli 默认只显示前 30 条,必须显式传 --limit 否则拿不到全量
    const requestedLimit = Number(limit);
    const cliLimit = requestedLimit > 0 ? Math.min(Math.trunc(requestedLimit), 500) : 500;
    args.push("--limit", String(cliLimit));
    const longR = await run115cli(args);
    let items = [];
    if (longR && typeof longR === "object" && longR._raw) {
      items = parseLsText(longR._raw);
    } else if (Array.isArray(longR)) {
      items = longR;
    } else if (longR?.files) {
      items = longR.files;
    }
    // 截断到 limit(0 = 不限制)
    const effectiveLimit = requestedLimit > 0 ? Math.trunc(requestedLimit) : Infinity;
    const truncated = items.length >= cliLimit || items.length > effectiveLimit;
    if (items.length > effectiveLimit) items = items.slice(0, effectiveLimit);
    return {
      path: targetPath,
      files: items,
      total: items.length,
      truncated,
      recent,
    };
  } catch (e) {
    throw new Error("pan115List failed: " + e.message);
  }
}

function parseHumanSize(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const text = String(value ?? "").trim().replaceAll(",", "")
  if (!text || text === "-") return 0
  const numeric = Number(text)
  if (Number.isFinite(numeric)) return numeric
  const match = text.match(/^([\d.]+)\s*(B|bytes?|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)$/i)
  if (!match) return 0
  const unit = match[2].toLowerCase()
  const power = unit === "b" || unit.startsWith("byte") ? 0 : ({ kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4, pb: 5, pib: 5 })[unit]
  return Number(match[1]) * 1024 ** power
}

function parseShareMtime(value) {
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : value
  const text = String(value || "").trim()
  if (!text) return 0
  const milliseconds = Date.parse(text)
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0
}

function shareListItems(result) {
  if (Array.isArray(result)) return result
  if (!result || typeof result !== "object") return []
  for (const key of ["files", "items", "entries", "list", "data"]) {
    if (Array.isArray(result[key])) return result[key]
    if (result[key] && typeof result[key] === "object") {
      for (const nestedKey of ["files", "items", "entries", "list"]) {
        if (Array.isArray(result[key][nestedKey])) return result[key][nestedKey]
      }
    }
  }
  if (result._raw) {
    try { return shareListItems(JSON.parse(result._raw)) }
    catch {
      if (/no entries found|empty share/i.test(result._raw)) return []
      throw new Error("115 share list did not return valid JSON")
    }
  }
  return []
}

export function normalizePan115ShareEntry(item, parentPath = "") {
  const rawName = String(item?.Name ?? item?.name ?? item?.file_name ?? item?.fileName ?? "")
  const name = rawName.replace(/\/$/, "")
  if (!name || name === "." || name === ".." || name.includes("/")) {
    throw new Error("115 share list returned an unsafe entry name")
  }
  const type = String(item?.Type ?? item?.type ?? "").toLowerCase()
  const taggedAsDir = type === "dir" || type === "directory" || item?.isDir === true || item?.is_dir === true || rawName.endsWith("/")
  const isDir = taggedAsDir && !looksLikeFile(name)
  const id = item?.ID ?? item?.id ?? item?.fid ?? item?.file_id
  const relativePath = path.posix.join(parentPath || "", name)
  return {
    id: id == null ? "" : String(id),
    name,
    path: relativePath,
    isDir,
    size: parseHumanSize(item?.Size ?? item?.size ?? item?.file_size),
    mtime: parseShareMtime(item?.Modified ?? item?.modified ?? item?.mtime),
  }
}

/** Build a testable share lister without exposing CLI mechanics to plugins. */
export function createPan115ShareLister({ available = isAvailable, run = run115cli } = {}) {
  return async function pan115ShareFiles(shareUrl, { pageSize = 200, maxFiles = 10_000, maxDepth = 10 } = {}) {
    if (!(await available())) throw new Error("115cli not installed")
    if (!shareUrl) throw new Error("shareUrl is required")
    const limit = Math.max(1, Math.min(500, Number.parseInt(pageSize, 10) || 200))
    const fileLimit = Math.max(1, Number.parseInt(maxFiles, 10) || 10_000)
    const depthLimit = Math.max(1, Math.min(20, Number.parseInt(maxDepth, 10) || 10))
    const password = extract115Pwd(shareUrl)
    const safeUrl = encodeFragmentPassword(shareUrl)
    const pending = [{ path: "", depth: 0 }]
    const visitedDirs = new Set([""])
    const files = []
    let entriesSeen = 0

    while (pending.length) {
      const directory = pending.shift()
      let offset = 0
      for (;;) {
        const args = ["share", "list"]
        if (password) args.push("-p", password)
        args.push("--limit", String(limit), "--offset", String(offset), "--format", "json", safeUrl, directory.path || "/")
        const result = await run(args, { timeoutMs: 90_000 })
        const page = shareListItems(result).map(item => normalizePan115ShareEntry(item, directory.path))
        entriesSeen += page.length
        if (entriesSeen > fileLimit * 2) throw new Error(`115 share exceeds the safe ${fileLimit} file traversal limit`)
        for (const item of page) {
          if (!item.name || !item.id) throw new Error("115 share list returned an item without an ID or name")
          if (item.isDir) {
            if (directory.depth >= depthLimit) throw new Error(`115 share exceeds the safe ${depthLimit}-level directory depth`)
            if (!visitedDirs.has(item.path)) {
              visitedDirs.add(item.path)
              pending.push({ path: item.path, depth: directory.depth + 1 })
            }
            continue
          }
          files.push(item)
          if (files.length > fileLimit) throw new Error(`115 share exceeds the safe ${fileLimit} file traversal limit`)
        }
        if (page.length < limit) break
        offset += page.length
        if (offset > fileLimit * 2) throw new Error("115 share listing exceeded the safe pagination limit")
      }
    }
    return files
  }
}

export const pan115ShareFiles = createPan115ShareLister()

// ── save ─────────────────────────────────────────────
// 实际 115cli 0.3.x:115cli share save [-p PASSWORD] [--dest DEST] <url> [path]
// 重要:
//   - path 位置参数是「分享内子目录」,不是目标 — 永远传 "/"
//   - --dest 才是真目标
//   - URL 自带 ?password=xxx 115cli 自动认,但 # 后的 fragment 不会发到服务器,要 extract 后用 -p 传
//   - 115cli mkdir 不接前导 "/",要用 -p + basename
export async function pan115Save(shareUrl, destPath, { selection } = {}) {
  if (!(await isAvailable())) throw new Error("115cli not installed");
  const selected = selection === undefined ? null : selection
  if (selected !== null && (!Array.isArray(selected) || selected.length === 0 || selected.some(item => {
    const relative = String(item?.path || "")
    return !item?.id || !relative || path.posix.isAbsolute(relative) || path.posix.normalize(relative).split("/").includes("..")
  }))) {
    throw new Error("115 selected save requires valid shared-file references")
  }
  // Validate the entire selection before creating or touching the destination.
  if (destPath && destPath !== "/") {
    await mkdirParents(destPath);
  }
  const paths = selected === null ? ["/"] : [...new Set(selected.map(item => String(item.path)))];
  let r = null
  for (const sharedPath of paths) {
    const args = ["share", "save"];
    const password = extract115Pwd(shareUrl);
    if (password) args.push("-p", password);
    const safeUrl = encodeFragmentPassword(shareUrl);
    args.push(safeUrl, sharedPath);
    if (destPath) args.push("--dest", destPath);
    r = await run115cli(args, { timeoutMs: 15 * 60_000 });
  }
  return {
    ok: true,
    savedCount: selected === null ? (r?.savedCount ?? r?.count ?? 1) : paths.length,
    task_id: r?.task_id ?? r?.taskId ?? null,
    raw: r,
  };
}

// 把 URL fragment 里的 #password=xxx 编码成 %23password=xxx(spawn 时 shell 不会误截断 # 后内容)
function encodeFragmentPassword(url) {
  try {
    const u = new URL(url);
    if (u.hash && u.hash.includes("password=")) {
      u.hash = u.hash.replace(/#/g, "%23");
    }
    return u.toString();
  } catch {
    return (url || "").replace(/#password=/g, "%23password=");
  }
}

// 建目录(链式)— 失败忽略(已存在)
// 115cli mkdir 不接前导 "/"(会报 990002 参数错误,拼成 ?path= 空)
// 也不接 0/ 这种段,用 -p 自动建父目录,只用 basename
export async function mkdirParents(p) {
  const parts = p.split("/").filter(Boolean);
  if (!parts.length) return;
  // 用 -p 让 115cli 自己建父链
  const fullPath = parts.join("/");
  try { await run115cli(["mkdir", "-p", fullPath]); }
  catch (e) {
    if (!/exists|already|EXISTS/i.test(String(e.message))) {
      console.warn("[115 mkdir -p]", fullPath, e.message);
    }
  }
  // 115 后端落地延迟
  await new Promise(r => setTimeout(r, 500));
}

// 115 密码可能藏在 query (?password=l822)或 fragment (#password=l822)里
// 注意:URL fragment 不会发给服务器,但 115 客户端从 URL 直接读时拿得到
function extract115Pwd(url) {
  try {
    const u = new URL(url);
    // 1) 优先 query
    let p = u.searchParams.get("password") || u.searchParams.get("pwd");
    if (p) return p;
    // 2) fragment:形如 #password=l822 或 #l822
    const hash = u.hash || "";
    const m = hash.match(/(?:^#|&)password=([^&]+)/i) || hash.match(/(?:^#|&)pwd=([^&]+)/i);
    if (m) return decodeURIComponent(m[1]);
    // 3) fragment 整段当密码(115 短链常见)
    if (hash.startsWith("#") && hash.length > 1 && !hash.includes("=")) {
      return decodeURIComponent(hash.slice(1));
    }
  } catch {
    // 退化:正则兜底
    const m = (url || "").match(/[?&#](?:password|pwd)=([^&#]+)/i);
    if (m) return decodeURIComponent(m[1]);
  }
  return "";
}

// ── move ─────────────────────────────────────────────
// 真实 115cli: 115cli mv <src> <destDir> + 115cli rename <path> <newName>
// 注意: 115cli mv 的 dest 是「目标目录」(help: Source path(s) followed by
//       destination directory),传完整文件路径会失败。跨目录改名需两步。
export async function pan115Move(src, dest) {
  if (!(await isAvailable())) throw new Error("115cli not installed");
  const srcDir = path.dirname(src)
  const destDir = path.dirname(dest)
  const newName = path.basename(dest)
  const oldName = path.basename(src)
  // 同目录重命名
  if (srcDir === destDir) {
    return await run115cli(["rename", src, newName])
  }
  // 跨目录:先 mv 到目标目录,再 rename
  await run115cli(["mv", src, destDir])
  const movedPath = destDir.replace(/\/$/, "") + "/" + oldName
  if (newName !== oldName) {
    return await run115cli(["rename", movedPath, newName])
  }
  return { ok: true }
}

// ── delete ───────────────────────────────────────────
// 真实 115cli: 115cli rm [-r] <path>
export async function pan115Delete(targetPath, { recursive = false } = {}) {
  if (!(await isAvailable())) throw new Error("115cli not installed");
  const normalizedTarget = path.posix.normalize(String(targetPath || ''));
  if (!targetPath || normalizedTarget === '/' || normalizedTarget === '.' || normalizedTarget === '..') {
    throw new Error("refusing to delete the 115 storage root");
  }
  const args = ["rm", targetPath];
  if (recursive) args.push("-r");
  return await run115cli(args);
}

// ── status (账号状态) ─────────────────────────────
// 实际 115cli 0.3.x:115cli account --format json
// 真实 JSON:{Username, "User ID", VIP, Expire}
export async function pan115Status() {
  if (!(await isAvailable())) {
    return { ok: false, configured: false, error: "115cli not installed" };
  }
  try {
    const r = await run115cli(["account", "--format", "json"]);
    return {
      ok: true, configured: true,
      username: (r?.Username ?? r?.username ?? r?.["User ID"] ?? r?.uid ?? PAN115_USER) || null,
      vip: r?.VIP ?? r?.vip ?? r?.isVip ?? false,
      expiresAt: r?.Expire ?? r?.expiresAt ?? r?.vip_expire ?? r?.expireAt ?? null,
      raw: r,
    };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

/** Import a user-supplied cookie into 115cli's configured credential directory. */
export async function pan115Authorize(cookie) {
  const value = validatePan115Cookie(cookie)
  if (!(await isAvailable())) throw new Error("115cli 未安装")
  try {
    await run115cli(["login", "cookie", value], { timeoutMs: 60_000 })
  } catch {
    // Never propagate CLI stderr: some versions include the supplied cookie in diagnostics.
    throw new Error("115 Cookie 导入失败")
  }
  const status = await pan115Status()
  if (!status.ok) throw new Error("115 Cookie 已导入，但账号验证失败")
  return {
    ok: true,
    username: status.username ?? null,
    vip: status.vip ?? null,
    expiresAt: status.expiresAt ?? null,
  }
}

/** Remove only the active user's cookie credential, not every stored 115 account. */
export async function pan115Logout() {
  if (!(await isAvailable())) throw new Error("115cli 未安装")
  try {
    await run115cli(["logout", "--type", "cookie"], { timeoutMs: 30_000 })
  } catch {
    throw new Error("115 授权退出失败")
  }
  return { ok: true, revoked: true }
}
