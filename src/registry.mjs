// 最小会话注册表：每个会话一个 meta.json。
// M1 只用于 ctm list / kill；M2 的跨进程路由会在此基础上扩展。
import fs from 'node:fs';
import path from 'node:path';

export function ctmHome() {
  return process.env.CTM_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.ctm');
}

// 会话名会被直接拼进路径（sessions/<name>），必须挡住 ../、分隔符和
// Windows 保留名。自动命名本来就会清洗，这里主要防显式传入的名字。
const SAFE_NAME = /^[\p{L}\p{N}._-]+$/u;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isValidSessionName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    name !== '.' &&
    name !== '..' &&
    !/[. ]$/.test(name) &&
    !WINDOWS_RESERVED.test(name) &&
    SAFE_NAME.test(name)
  );
}

export function sessionDir(name) {
  if (!isValidSessionName(name)) throw new Error(`会话名不合法：${name}`);
  return path.join(ctmHome(), 'sessions', name);
}

export function writeMeta(name, meta) {
  const dir = sessionDir(name);
  fs.mkdirSync(dir, { recursive: true });
  // 原子替换：读取方可能并发读，不能看到半个 JSON
  const tmp = path.join(dir, `meta.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, path.join(dir, 'meta.json'));
}

export function readMeta(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir(name), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function removeMeta(name) {
  try {
    fs.rmSync(path.join(sessionDir(name), 'meta.json'), { force: true });
  } catch {
    // 忽略
  }
}

export function listSessions() {
  const root = path.join(ctmHome(), 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readMeta(e.name))
    .filter(Boolean);
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM：进程存在，只是当前用户没有发信号的权限。
    // 当成存活，否则会误判为离线并重复拉起。
    return e && e.code === 'EPERM';
  }
}
