// vpn-skill :: src/util.mjs — 终端输出、参数解析、小工具
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const c = {
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
  dim: wrap(2),
  bold: wrap(1),
};

export const log = (...a) => console.log(...a);
export const info = (...a) => console.log(`${c.cyan('[ .. ]')} ${a.join(' ')}`);
export const ok = (...a) => console.log(`${c.green('[ ok ]')} ${a.join(' ')}`);
export const warn = (...a) => console.error(`${c.yellow('[warn]')} ${a.join(' ')}`);
export const fail = (...a) => console.error(`${c.red('[fail]')} ${a.join(' ')}`);

export function die(msg, code = 1) {
  fail(msg);
  process.exit(code);
}

export function banner(title) {
  log('');
  log(c.bold(`==============================================`));
  log(c.bold(`  ${title}`));
  log(c.bold(`==============================================`));
}

// ---------------------------------------------------------------------------
// 参数解析：支持 --k v / --k=v / -h / 布尔开关
// ---------------------------------------------------------------------------
export function parseArgv(argv, { booleans = [], aliases = {} } = {}) {
  const boolSet = new Set(booleans);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const long = a.startsWith('--') ? a.slice(2) : a.slice(1);
      let key = long;
      let val;
      const eq = long.indexOf('=');
      if (eq >= 0) {
        key = long.slice(0, eq);
        val = long.slice(eq + 1);
      }
      key = aliases[key] || key;
      if (val === undefined) {
        const next = argv[i + 1];
        if (boolSet.has(key) || next === undefined || (next.startsWith('-') && next.length > 1 && !/^-\d/.test(next))) {
          val = boolSet.has(key) ? true : true;
        } else {
          val = next;
          i++;
        }
      } else if (boolSet.has(key)) {
        val = !/^(0|false|no)$/i.test(String(val));
      }
      if (out[key] !== undefined) {
        out[key] = Array.isArray(out[key]) ? [...out[key], val] : [out[key], val];
      } else {
        out[key] = val;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function which(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').toString(),
    stderr: (r.stderr || '').toString(),
    error: r.error,
  };
}

export function isPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function isIPv4(s) {
  if (typeof s !== 'string') return false;
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function randomPort(lo = 20000, hi = 65000) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 单引号包裹，供 bash 安全使用 */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function humanAge(sec) {
  if (!Number.isFinite(sec)) return 'unknown';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}天${h}小时`;
  if (h) return `${h}小时${m}分`;
  return `${m}分`;
}

export function localStateDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'vpn-skill');
  }
  return path.join(os.homedir(), '.vpn-skill');
}
