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
//      - 若是 shim，解析其内容拿到真实 exe
//   3. 都找不到则抛错，绝不回退到裸名
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXT_CANDIDATES = ['.exe', '.cmd', '.bat', ''];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// npm 生成的 claude.cmd 用 %~dp0 / %dp0% 拼路径
function exeFromCmdShim(shimPath) {
  let content;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const expanded = content
    .replace(/%~dp0\\?/gi, dir + '\\')
    .replace(/%dp0%\\?/gi, dir + '\\');
  const m =
    expanded.match(/"([^"\r\n]+?\.exe)"/i) || expanded.match(/([A-Za-z]:\\[^"\r\n]+?\.exe)/i);
  if (!m) return null;
  const p = path.normalize(m[1]);
  return isFile(p) ? p : null;
}

// npm 生成的 claude（sh shim）用 $basedir
function exeFromShShim(shimPath) {
  let content;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const m = content.match(/exec\s+"?\$basedir\/([^"\s]+\.exe)"?/);
  if (!m) return null;
  const resolved = path.resolve(path.dirname(shimPath), m[1]);
  return isFile(resolved) ? resolved : null;
}

function resolveShim(shimPath, ext) {
  return ext === '.cmd' || ext === '.bat' ? exeFromCmdShim(shimPath) : exeFromShShim(shimPath);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ bin: string, via: string, candidates?: Array<{path:string, order:number}> }}
 */
export function resolveClaudeBin(env = process.env) {
  if (env.CTM_CLAUDE_BIN) {
    if (!isFile(env.CTM_CLAUDE_BIN)) {
      throw new Error(`CTM_CLAUDE_BIN 指向的文件不存在：${env.CTM_CLAUDE_BIN}`);
    }
    return { bin: env.CTM_CLAUDE_BIN, via: 'CTM_CLAUDE_BIN' };
  }

  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const hits = [];

  for (let order = 0; order < dirs.length; order++) {
    const dir = dirs[order];
    for (const ext of EXT_CANDIDATES) {
      const p = path.join(dir, 'claude' + ext);
      if (!isFile(p)) continue;
      if (ext === '.exe') {
        hits.push({ path: p, order, kind: 'exe' });
      } else {
        // shim 必须能解析出真实 exe，解析失败的跳过
        const target = resolveShim(p, ext);
        if (target) hits.push({ path: target, order, kind: 'shim', shim: p });
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
  return {
    bin: first.path,
    via: first.kind === 'exe' ? `PATH 中的 claude.exe` : `解析 ${path.extname(first.shim) || 'sh'} shim`,
    shim: first.shim,
    candidates: hits,
  };
}

/** 读取二进制版本，失败返回 null */
export function claudeVersion(bin, timeout = 30000) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout });
    return out.trim().split('\n')[0];
  } catch {
    return null;
  }
}
