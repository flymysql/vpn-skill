// vpn-skill :: src/ssh.mjs
// 跨平台 SSH/SFTP 传输层（ssh2）：密码与私钥都支持，Windows 上无需 sshpass/plink。
// 同时尊重 ~/.ssh/config 的 HostName/User/Port/IdentityFile —— 用户平时 `ssh myhost` 能通的，
// 这里给 --host myhost 也应该能通（否则就得手工重复一遍参数）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from 'ssh2';
import { expandHome, info, warn } from './util.mjs';

// ---------------------------------------------------------------------------
// ~/.ssh/config 解析（OpenSSH 语义：按文件顺序，首个命中的值生效）
// ---------------------------------------------------------------------------
function globMatch(pattern, name) {
  if (pattern === '*') return true;
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i',
  );
  return re.test(name);
}

function readSshConfigFile(file, depth = 0) {
  if (depth > 3 || !fs.existsSync(file)) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)[\s=]+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'include') {
      for (const inc of val.split(/\s+/).filter(Boolean)) {
        const p = path.isAbsolute(inc) ? inc : path.join(os.homedir(), ...inc.replace(/^~[/\\]/, '').split(/[/\\]/));
        out.push(...readSshConfigFile(p, depth + 1));
      }
      continue;
    }
    if (key === 'host') {
      cur = { patterns: val.split(/\s+/).filter(Boolean), opts: {} };
      out.push(cur);
      continue;
    }
    if (cur) cur.opts[key] = val;
  }
  return out;
}

export function sshConfigFor(host) {
  const merged = {};
  for (const block of readSshConfigFile(path.join(os.homedir(), '.ssh', 'config'))) {
    if (!block.patterns.some((p) => globMatch(p, host))) continue;
    for (const [k, v] of Object.entries(block.opts)) {
      if (merged[k] === undefined) merged[k] = v; // first-wins
    }
  }
  return merged;
}

/** 把 CLI 参数 + ~/.ssh/config 合成最终连接参数 */
export function resolveConn(a = {}) {
  const host = a.host || a.server || a.ip;
  if (!host) throw new Error('缺少服务器地址（--host）');
  const cfg = sshConfigFor(host);
  return {
    host: cfg.hostname || host,
    port: Number(a.port || a.sshPort || cfg.port || 22),
    username: a.user || a.username || cfg.user || 'root',
    password: a.password,
    identityFile: a.key || a.privateKey || a['identity-file'] || a.identityFile || cfg.identityfile,
    passphrase: a.passphrase || a.keyPassphrase,
    fromConfig: Object.keys(cfg).length > 0 ? cfg : null,
  };
}

function readKey(p, label) {
  const full = path.resolve(expandHome(p));
  if (!fs.existsSync(full)) {
    if (label === 'explicit') throw new Error(`私钥文件不存在: ${full}`);
    return null;
  }
  const buf = fs.readFileSync(full);
  if (!/PRIVATE KEY/.test(buf.subarray(0, 200).toString('utf8'))) {
    warn(`${full} 看起来不是私钥文件，已跳过`);
    return null;
  }
  return buf;
}

function defaultKeyPaths() {
  return ['id_ed25519', 'id_rsa', 'id_ecdsa'].map((f) => path.join(os.homedir(), '.ssh', f));
}

/** 生成按优先级排列的候选连接配置，逐个尝试。
 *  顺序：显式密码 → 显式私钥 → ~/.ssh/config 的 IdentityFile → ~/.ssh 下的默认私钥。
 *  之所以显式私钥失败后还继续试：用户很可能给了错的那个，而 ssh 能通的那个就在 config 里。 */
function candidateConfigs(a) {
  const r = resolveConn(a);
  const base = { readyTimeout: Number(a.timeoutMs || 25000), keepaliveInterval: 15000, keepaliveCountMax: 6 };
  const out = [];
  const push = (c) => {
    const key = `${c.username}@${c.host}:${c.port}|${c.password ? 'pw' : ''}${c.privateKey ? `k${c.privateKey.length}` : ''}`;
    if (!out.some((x) => x._k === key)) out.push({ ...c, _k: key });
  };
  if (r.password) push({ ...base, host: r.host, port: r.port, username: r.username, password: r.password });

  const keyPaths = [];
  if (r.identityFile) keyPaths.push([r.identityFile, 'explicit']);
  for (const p of defaultKeyPaths()) {
    if (!keyPaths.some(([x]) => path.resolve(expandHome(x)) === path.resolve(p))) keyPaths.push([p, 'default']);
  }
  for (const [kp, label] of keyPaths) {
    const k = readKey(kp, label);
    if (k) push({ ...base, host: r.host, port: r.port, username: r.username, privateKey: k, passphrase: r.passphrase });
  }
  if (out.length === 0) throw new Error('请提供登录方式：--password <密码> 或 --key <私钥文件>');
  return out;
}

export function normalizeConn(a = {}) {
  const [first] = candidateConfigs(a);
  const { _k, ...rest } = first;
  return rest;
}

async function tryConnect(cfg) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    conn.on('ready', () => done(resolve, conn));
    conn.on('error', (e) => done(reject, new Error(e.message)));
    conn.on('close', () => done(reject, new Error('连接被远端关闭')));
    try {
      conn.connect(cfg);
    } catch (e) {
      done(reject, e);
    }
  });
}

export async function connect(a = {}) {
  const r = resolveConn(a);
  const cands = candidateConfigs(a);
  let lastErr = null;
  for (const c of cands) {
    try {
      const conn = await tryConnect(c);
      if (r.fromConfig) {
        const used = c.privateKey ? 'key' : 'password';
        info(`已按 ~/.ssh/config 解析：${c.username}@${c.host}:${c.port} (${used})`);
      }
      return conn;
    } catch (e) {
      lastErr = e;
      if (cands.length > 1) warn(`认证失败（${c.privateKey ? '私钥' : '密码'}），尝试下一种凭据`);
    }
  }
  const friendly = /authentication methods failed|Cannot parse privateKey/i.test(lastErr?.message || '')
    ? `SSH ${r.username}@${r.host}:${r.port} 认证失败：已尝试 ${cands.length} 种凭据。请检查 --user/--password/--key，或确认 ~/.ssh/config 中该主机的 IdentityFile`
    : `SSH ${r.username}@${r.host}:${r.port} 连接失败: ${lastErr?.message}`;
  throw new Error(friendly);
}

/** 执行命令，返回 {code, stdout, stderr}；onLine 用于实时透传日志 */
export function exec(conn, cmd, opts = {}) {
  const { timeoutMs = 600000, onLine = null, stdin = null, env = null } = opts;
  let full = cmd;
  if (env && Object.keys(env).length) {
    const pre = Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)};`).join(' ');
    full = `${pre} ${cmd}`;
  }
  return new Promise((resolve, reject) => {
    conn.exec(full, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let settled = false;
      let code = null;
      let signal = null;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try { stream.close(); } catch { /* ignore */ }
            reject(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)}s）: ${cmd.slice(0, 120)}`));
          }, timeoutMs)
        : null;
      const finish = (c, s) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code: c ?? code ?? 0, signal: s ?? signal, stdout, stderr });
      };
      stream.on('exit', (c, s) => { code = c; signal = s; });
      stream.on('close', (c, s) => finish(c, s));
      stream.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        if (onLine) onLine(s, 'out');
      });
      stream.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (onLine) onLine(s, 'err');
      });
      if (stdin !== null && stdin !== undefined) {
        stream.write(stdin);
        stream.end();
      }
    });
  });
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function sftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
}

export async function writeRemote(conn, remotePath, data, mode = 0o644) {
  const s = await sftp(conn);
  const dir = path.posix.dirname(remotePath);
  await new Promise((res) => s.mkdir(dir, { recursive: true }, () => res()));
  await new Promise((res, rej) => {
    s.writeFile(remotePath, data, { mode }, (err) => (err ? rej(err) : res()));
  });
  s.end();
}

export async function readRemoteText(conn, remotePath) {
  const s = await sftp(conn);
  const buf = await new Promise((res, rej) => {
    s.readFile(remotePath, (err, data) => (err ? rej(err) : res(data)));
  });
  s.end();
  return buf.toString('utf8');
}

export async function downloadRemote(conn, remotePath, localPath) {
  const s = await sftp(conn);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  await new Promise((res, rej) => {
    s.fastGet(remotePath, localPath, (err) => (err ? rej(err) : res()));
  });
  s.end();
  return localPath;
}

export async function close(conn) {
  if (!conn) return;
  try { conn.end(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 60));
}

/**
 * 以 root 身份运行一段脚本片段（自动处理 sudo：免密 → -n，有密码 → -S 喂 stdin）
 * 返回 {code, stdout, stderr, usedSudo}
 */
export async function execRoot(conn, script, { password, timeoutMs, onLine, fallbackToUser = false } = {}) {
  const probe = await exec(conn, 'id -u', { timeoutMs: 15000 });
  const isRoot = probe.stdout.trim() === '0';
  if (isRoot) {
    const r = await exec(conn, `bash -c ${shq(script)}`, { timeoutMs, onLine });
    return { ...r, usedSudo: false };
  }
  const canSudoN = await exec(conn, 'sudo -n true 2>/dev/null && echo SUDO_N_OK || echo NO', { timeoutMs: 20000 });
  if (canSudoN.stdout.includes('SUDO_N_OK')) {
    const r = await exec(conn, `sudo -n bash -c ${shq(script)}`, { timeoutMs, onLine });
    return { ...r, usedSudo: 'sudo -n' };
  }
  if (!password) {
    if (fallbackToUser) {
      warn('目标机非 root 且 sudo 不可免密，按当前用户执行（dry-run 允许）');
      const r = await exec(conn, `bash -c ${shq(script)}`, { timeoutMs, onLine });
      return { ...r, usedSudo: 'none(fallback)' };
    }
    const e = new Error('目标机非 root，且 sudo 需要密码。请追加 --sudo-password <密码>（或直接用 root 登录）');
    e.code = 'NEED_SUDO_PASSWORD';
    throw e;
  }
  info('目标机非 root，使用 sudo -S 提权');
  const r = await exec(conn, `sudo -S -p '' bash -c ${shq(script)}`, {
    timeoutMs,
    onLine,
    stdin: `${password}\n`,
  });
  if (/incorrect password|Sorry, try again/i.test(r.stderr)) {
    throw new Error('sudo 密码错误');
  }
  return { ...r, usedSudo: 'sudo -S' };
}

export async function serverInfo(conn) {
  const r = await exec(conn, 'printf "%s\\n" "$(id -un)" "$(uname -s)" "$(uname -m)" "$( (cat /etc/os-release 2>/dev/null | . /dev/stdin; echo $PRETTY_NAME) 2>/dev/null )"; echo "--"; (systemctl is-system-running 2>/dev/null || echo no-systemd)', { timeoutMs: 20000 });
  const [user, osName, arch] = r.stdout.split('\n');
  return { user, osName, arch, raw: r.stdout };
}

export { warn };
