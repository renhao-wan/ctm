// 解析 claude 可执行文件的绝对路径。
//
// 为什么必须做这件事：
//   node-pty 在 Windows 上走 CreateProcessW，只按 .exe 查找，
//   不认 PATHEXT，也不认 npm 生成的 sh shim 与 .cmd。
//   如果 npm 全局安装排在 PATH 前面但只有 claude.cmd，spawn('claude')
//   会跳过它，落到 PATH 后面任意一个 claude.exe（可能是别的工具自带的
//   另一个版本）。用户终端里执行的是 2.1.234，托管进程却可能是 2.1.319。
//
// 解析顺序：
//   1. CTM_CLAUDE_BIN 环境变量
//   2. PATH 中位置最靠前的 claude 入口（.exe / .cmd / .bat / sh shim）
//      - 若是 shim，解析其内容拿到真实 exe；只有 node + cli.js 的安装方式
//        返回 bin=node.exe、prefix=[cli.js]
//   3. 都找不到则抛错，绝不回退到裸名
//
// 必须排除 ctm 自己生成的 claude 包装（bin/claude.cmd）：它内部也是
// “node.exe + main.mjs wrap”，若被当成 claude 会无限递归。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXT_CANDIDATES = ['.exe', '.cmd', '.bat', ''];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CTM_ENTRY = path.resolve(HERE, 'main.mjs');

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function looksLikeCtmWrapper(content) {
  return content.includes('ctm-wrap');
}

// npm 生成的 claude.cmd 用 %~dp0 / %dp0% 拼路径
function fromCmdShim(shimPath) {
  let content;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  if (looksLikeCtmWrapper(content)) return null;

  const dir = path.dirname(shimPath);
  const expanded = content
    .replace(/%~dp0\\?/gi, dir + '\\')
    .replace(/%dp0%\\?/gi, dir + '\\');

  const exes = [...expanded.matchAll(/"([^"\r\n]+?\.exe)"/gi)]
    .map((m) => path.normalize(m[1]))
    .filter(isFile);

  // 1) 直接指向 claude 自己的 exe
  const claudeExe = exes.find((p) => /claude[^\\/]*\.exe$/i.test(p));
  if (claudeExe) return { bin: claudeExe, prefix: [] };

  // 2) node.exe + cli.js 的安装方式
  const nodeJs = expanded.match(/"([^"\r\n]+?node\.exe)"\s+"?([^"\r\n]+?\.js)"?/i);
  if (nodeJs) {
    const node = path.normalize(nodeJs[1]);
    const js = path.resolve(path.normalize(nodeJs[2]));
    if (js === CTM_ENTRY) return null;
    if (isFile(node) && isFile(js)) return { bin: node, prefix: [js] };
  }

  // 3) 任意非 node 的 exe（避免把解释器当成 claude）
  const other = exes.find((p) => !/node\.exe$/i.test(p));
  return other ? { bin: other, prefix: [] } : null;
}

// npm 生成的 claude（sh shim）用 $basedir
function fromShShim(shimPath) {
  let content;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  if (looksLikeCtmWrapper(content)) return null;

  const dir = path.dirname(shimPath);
  const exe = content.match(/exec\s+"?\$basedir\/([^"\s]+\.exe)"?/);
  if (exe) {
    const p = path.resolve(dir, exe[1]);
    if (isFile(p)) return { bin: p, prefix: [] };
  }

  const nodeJs = content.match(/exec\s+"?\$basedir\/node"?\s+"?\$basedir\/([^"\s]+\.js)"?/);
  if (nodeJs) {
    const node = path.join(dir, 'node');
    const js = path.resolve(dir, nodeJs[1]);
    if (js === CTM_ENTRY) return null;
    if (isFile(node) && isFile(js)) return { bin: node, prefix: [js] };
  }
  return null;
}

function resolveShim(shimPath, ext) {
  return ext === '.cmd' || ext === '.bat' ? fromCmdShim(shimPath) : fromShShim(shimPath);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ bin: string, prefix: string[], via: string, candidates?: Array<object> }}
 */
export function resolveClaudeBin(env = process.env) {
  if (env.CTM_CLAUDE_BIN) {
    if (!isFile(env.CTM_CLAUDE_BIN)) {
      throw new Error(`CTM_CLAUDE_BIN 指向的文件不存在：${env.CTM_CLAUDE_BIN}`);
    }
    return { bin: env.CTM_CLAUDE_BIN, prefix: [], via: 'CTM_CLAUDE_BIN' };
  }

  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const hits = [];

  for (let order = 0; order < dirs.length; order++) {
    const dir = dirs[order];
    for (const ext of EXT_CANDIDATES) {
      const p = path.join(dir, 'claude' + ext);
      if (!isFile(p)) continue;
      if (ext === '.exe') {
        hits.push({ path: p, prefix: [], order, kind: 'exe' });
      } else {
        // shim 必须能解析出真实入口，解析失败的跳过
        const target = resolveShim(p, ext);
        if (target) {
          hits.push({
            path: target.bin,
            prefix: target.prefix,
            order,
            kind: 'shim',
            shim: p,
            nodeJs: target.prefix.length > 0,
          });
        }
      }
      break; // 同一目录只取优先级最高的入口
    }
  }

  if (hits.length === 0) {
    throw new Error(
      '未能在 PATH 中解析到 claude 可执行文件。请确认已安装 Claude Code，或设置 CTM_CLAUDE_BIN 指向 claude.exe。',
    );
  }

  const first = hits[0];
  let via = 'PATH 中的 claude.exe';
  if (first.kind === 'shim') {
    via = first.nodeJs
      ? `解析 ${path.extname(first.shim) || 'sh'} shim（node + cli.js）`
      : `解析 ${path.extname(first.shim) || 'sh'} shim`;
  }
  return {
    bin: first.path,
    prefix: first.prefix,
    via,
    shim: first.shim,
    candidates: hits,
  };
}

/** 读取二进制版本，失败返回 null */
export function claudeVersion(bin, prefix = [], timeout = 30000) {
  try {
    const out = execFileSync(bin, [...prefix, '--version'], { encoding: 'utf8', timeout });
    return out.trim().split('\n')[0];
  } catch {
    return null;
  }
}
