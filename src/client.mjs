// vpn-skill :: src/client.mjs
// 本机客户端：下载 mihomo 内核 → 写配置 → 起进程 → 设系统代理 → 验证出网。三端（Windows/macOS/Linux）共用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  c, log, info, ok, warn, fail, ensureDir, localStateDir, which, run, sleep,
} from './util.mjs';
import {
  buildMihomoConfig, buildSubscription, buildLink, mihomoProxy,
} from './protocols.mjs';
import {
  downloadWithMirrors, mihomoAsset, mihomoUrl, pinned, resolveTag, httpDownload,
} from './download.mjs';
import { gunzipFile, unzipFile } from './archive.mjs';
import { downloadRemote, exec } from './ssh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

export const DEFAULT_PROXY_PORT = 7890;
export const DEFAULT_CONTROLLER_PORT = 9090;

export const paths = (dir) => ({
  dir,
  bin: path.join(dir, IS_WIN ? 'mihomo.exe' : 'mihomo'),
  config: path.join(dir, 'config.yaml'),
  meta: path.join(dir, 'meta.json'),
  log: path.join(dir, 'mihomo.log'),
  link: path.join(dir, 'link.txt'),
  subscription: path.join(dir, 'subscription.yaml'),
  proxyBackup: path.join(dir, 'system-proxy.backup.json'),
  tunDll: path.join(dir, 'wintun.dll'),
});

export function readMeta(dir) {
  const p = paths(dir).meta;
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeMeta(dir, meta) {
  ensureDir(dir);
  fs.writeFileSync(paths(dir).meta, JSON.stringify(meta, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 内核下载
// ---------------------------------------------------------------------------
async function ensureCore(p, { force = false, ssh = null, tagOverride = null } = {}) {
  if (!force && fs.existsSync(p.bin)) {
    const v = run(p.bin, ['-v']).stdout.trim();
    if (v) { ok(`mihomo 内核已就绪: ${v.split('\n')[0]}`); return p.bin; }
    warn('已有 mihomo 无法执行，重新下载');
  }
  const tag = tagOverride || pinned('mihomo') || (await resolveTag('MetaCubeX/mihomo', 'v1.19.31'));
  const asset = mihomoAsset(process.platform, process.arch, tag);
  const url = mihomoUrl(tag, asset.name);
  info(`获取 mihomo ${tag} (${asset.name})`);

  const cacheDir = ensureDir(path.join(p.dir, 'cache'));
  const rawPath = path.join(cacheDir, asset.name);
  let got = null;

  if (!fs.existsSync(rawPath) || force) {
    got = await downloadWithMirrors(url, rawPath);
  } else {
    got = { path: rawPath, from: 'cache' };
  }

  // 兜底：把下载动作放到海外服务器上做，再 SFTP 拉回（墙内直连 GitHub 不通时唯一稳的路）
  if (!got && ssh) {
    warn('本机所有下载源均失败，改用「服务器中转」模式');
    const remoteRaw = `/tmp/${asset.name}`;
    const r = await exec(
      ssh,
      `curl -fsSL --retry 2 -o ${remoteRaw} '${url}' && ls -l ${remoteRaw}`,
      { timeoutMs: 300000 },
    );
    if (r.code === 0) {
      await downloadRemote(ssh, remoteRaw, rawPath);
      got = { path: rawPath, from: 'server-relay' };
      ok('已通过服务器中转取回内核');
    } else {
      warn(`服务器中转也失败: ${r.stderr.trim().slice(0, 200)}`);
    }
  }
  if (!got) throw new Error('mihomo 内核下载失败：请检查网络，或设置 VPN_MIRRORS 指定可用镜像');

  if (asset.kind === 'gz') {
    gunzipFile(rawPath, p.bin);
  } else {
    unzipFile(rawPath, p.dir, { wanted: ['mihomo.exe', `mihomo-windows-${asset.name.split('-')[2]}.exe`] });
    const produced = fs.readdirSync(p.dir).find((f) => /^mihomo.*\.exe$/i.test(f));
    if (!produced) throw new Error('zip 内未找到 mihomo.exe');
    if (path.join(p.dir, produced) !== p.bin) fs.renameSync(path.join(p.dir, produced), p.bin);
  }
  if (!IS_WIN) fs.chmodSync(p.bin, 0o755);

  const v = run(p.bin, ['-v']);
  if (v.code !== 0) throw new Error(`mihomo 无法执行: ${v.stderr || v.error?.message || 'unknown'}`);
  ok(`mihomo 安装完成: ${v.stdout.trim().split('\n')[0]}`);
  return p.bin;
}

async function ensureTunDll(p, { ssh = null } = {}) {
  if (!IS_WIN || fs.existsSync(p.tunDll)) return;
  const url = 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.31/wintun-0.14.1.zip';
  const zip = path.join(p.dir, 'cache', 'wintun.zip');
  info('TUN 模式需要 wintun.dll，尝试获取');
  let got = await downloadWithMirrors(url, zip, { quiet: true });
  if (!got && ssh) {
    const remote = '/tmp/wintun.zip';
    const r = await exec(ssh, `curl -fsSL -o ${remote} '${url}'`, { timeoutMs: 180000 });
    if (r.code === 0) { await downloadRemote(ssh, remote, zip); got = true; }
  }
  if (!got) { warn('wintun.dll 获取失败，TUN 模式将不可用（可改用手工下载放入目录）'); return; }
  try {
    const files = unzipFile(zip, p.dir, { wanted: ['wintun.dll'] });
    if (files.length) ok(`wintun.dll 已就绪 (${path.basename(files[0])})`);
  } catch (e) {
    warn(`wintun.dll 解压失败: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 安装 / 配置
// ---------------------------------------------------------------------------
export async function installClient(state, opts = {}) {
  const dir = ensureDir(opts.dir || localStateDir());
  const p = paths(dir);
  const prev = readMeta(dir) || {};
  const proxyPort = Number(opts.proxyPort || prev.proxyPort || DEFAULT_PROXY_PORT);
  const controllerPort = Number(opts.controllerPort || prev.controllerPort || DEFAULT_CONTROLLER_PORT);
  const tun = !!opts.tun;
  const secret = prev.secret || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  log('');
  info(`客户端目录: ${dir}`);
  await ensureCore(p, { force: !!opts.force, ssh: opts.ssh || null });
  if (tun) await ensureTunDll(p, { ssh: opts.ssh || null });

  const cfg = buildMihomoConfig(state, { proxyPort, controllerPort, secret, tun });
  fs.writeFileSync(p.config, cfg, 'utf8');
  ok(`配置已写入 ${p.config}（${state.protocol} · 混合端口 ${proxyPort}${tun ? ' · TUN' : ''}）`);

  const link = buildLink(state);
  fs.writeFileSync(p.link, `${link}\n`, 'utf8');
  fs.writeFileSync(p.subscription, buildSubscription(state), 'utf8');

  writeMeta(dir, {
    ...prev,
    proxyPort,
    controllerPort,
    secret,
    tun,
    state,
    link,
    installedAt: prev.installedAt || Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
  });
  ok(`分享链接: ${p.link}`);
  ok(`订阅文件: ${p.subscription}（可导入 Clash Verge / ClashX）`);
  return { dir, ...p, proxyPort, controllerPort, secret, tun };
}

// ---------------------------------------------------------------------------
// 进程控制
// ---------------------------------------------------------------------------
export async function startClient(dir, { quiet = false } = {}) {
  const p = paths(dir);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`未找到客户端配置，请先执行 install（目录 ${dir}）`);
  if (!fs.existsSync(p.bin)) throw new Error(`mihomo 内核缺失: ${p.bin}`);

  const st = await clientStatus(dir);
  if (st.running) {
    if (!quiet) info(`mihomo 已在运行 (pid ${st.pid})`);
    return { alreadyRunning: true, ...st };
  }

  const fd = fs.openSync(p.log, 'a');
  const child = spawn(p.bin, ['-d', dir, '-f', p.config], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.writeFileSync(path.join(dir, 'mihomo.pid'), String(child.pid));
  meta.pid = child.pid;
  meta.lastStart = Math.floor(Date.now() / 1000);
  writeMeta(dir, meta);

  // 等端口就绪
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await portOpen('127.0.0.1', meta.proxyPort)) {
      if (!quiet) ok(`mihomo 已启动 (pid ${child.pid}, 混合端口 ${meta.proxyPort})`);
      return { pid: child.pid, port: meta.proxyPort };
    }
    await sleep(300);
  }
  const tail = tailLog(p.log, 15);
  throw new Error(`mihomo 启动后端口 ${meta.proxyPort} 未监听。日志尾部:\n${tail}`);
}

export async function stopClient(dir, { quiet = false } = {}) {
  const p = paths(dir);
  const meta = readMeta(dir);
  let pid = meta?.pid;
  const pidFile = path.join(dir, 'mihomo.pid');
  if (fs.existsSync(pidFile)) {
    const v = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(v) && v > 0) pid = v;
  }
  if (!pid) {
    if (!quiet) info('没有记录的 mihomo 进程');
    return { stopped: false };
  }
  if (IS_WIN) {
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
    await sleep(800);
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ }
  if (meta) { delete meta.pid; writeMeta(dir, meta); }
  if (!quiet) ok(`已停止 mihomo (pid ${pid})`);
  return { stopped: true, pid };
}

export async function clientStatus(dir) {
  const p = paths(dir);
  const meta = readMeta(dir);
  if (!meta) return { installed: false, running: false };
  let pid = meta.pid;
  const pidFile = path.join(dir, 'mihomo.pid');
  if (fs.existsSync(pidFile)) {
    const v = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(v) && v > 0) pid = v;
  }
  const alive = pid ? isAlive(pid) : false;
  const listening = await portOpen('127.0.0.1', meta.proxyPort);
  const running = alive && listening;
  let controller = null;
  if (running) controller = await controllerInfo(meta).catch(() => null);
  return {
    installed: true,
    running,
    pid,
    alive,
    listening,
    port: meta.proxyPort,
    controllerPort: meta.controllerPort,
    tun: meta.tun,
    protocol: meta.state?.protocol,
    host: meta.state?.host,
    controller,
    logTail: running ? null : tailLog(p.log, 10),
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function tailLog(file, lines = 20) {
  if (!fs.existsSync(file)) return '(无日志)';
  const txt = fs.readFileSync(file, 'utf8');
  return txt.split(/\r?\n/).slice(-lines).join('\n');
}

export function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

async function controllerInfo(meta) {
  const res = await fetch(`http://127.0.0.1:${meta.controllerPort}/version`, {
    headers: { Authorization: `Bearer ${meta.secret}` },
    signal: AbortSignal.timeout(2500),
  });
  return res.ok ? res.json() : null;
}

// ---------------------------------------------------------------------------
// 系统代理
// ---------------------------------------------------------------------------
export async function setSystemProxy(dir) {
  const meta = readMeta(dir);
  if (!meta) throw new Error('未安装客户端');
  const { proxyPort } = meta;
  if (IS_WIN) return winSystemProxy('set', dir, proxyPort);
  if (process.platform === 'darwin') return macSystemProxy('set', dir, proxyPort);
  return linuxSystemProxy('set', dir, proxyPort);
}

export async function clearSystemProxy(dir) {
  if (IS_WIN) return winSystemProxy('clear', dir);
  if (process.platform === 'darwin') return macSystemProxy('clear', dir);
  return linuxSystemProxy('clear', dir);
}

export async function getSystemProxy(dir) {
  if (IS_WIN) return winSystemProxy('get', dir);
  if (process.platform === 'darwin') return macSystemProxy('get', dir);
  return linuxSystemProxy('get', dir);
}

function psFile() {
  return path.join(HERE, 'win', 'systemproxy.ps1');
}

function winSystemProxy(action, dir, proxyPort) {
  const p = paths(dir);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile(), '-Action', action];
  if (action === 'set') {
    args.push('-ProxyServer', `127.0.0.1:${proxyPort}`, '-BackupPath', p.proxyBackup);
  } else if (action === 'clear') {
    args.push('-BackupPath', p.proxyBackup);
  }
  const r = run('powershell.exe', args, { timeout: 30000 });
  if (r.code !== 0) throw new Error(`设置系统代理失败: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return { raw: r.stdout.trim() };
  }
}

const BYPASS_DOMAINS = ['localhost', '127.0.0.1', '*.local', '10.*', '172.16/12', '192.168/16', '169.254/16'];

function macSystemProxy(action, dir, proxyPort) {
  if (action === 'get') {
    const r = run('networksetup', ['-getwebproxy', 'Wi-Fi']);
    return { raw: r.stdout.trim() };
  }
  const list = run('networksetup', ['-listallnetworkservices']).stdout
    .split('\n').slice(1).map((s) => s.trim()).filter((s) => s && !s.startsWith('*'));
  const p = paths(dir);
  if (action === 'set') {
    if (!fs.existsSync(p.proxyBackup)) {
      const snap = {};
      for (const svc of list) {
        snap[svc] = {
          web: run('networksetup', ['-getwebproxy', svc]).stdout,
          secure: run('networksetup', ['-getsecurewebproxy', svc]).stdout,
        };
      }
      fs.writeFileSync(p.proxyBackup, JSON.stringify(snap, null, 2));
    }
    for (const svc of list) {
      run('networksetup', ['-setwebproxy', svc, '127.0.0.1', String(proxyPort)]);
      run('networksetup', ['-setsecurewebproxy', svc, '127.0.0.1', String(proxyPort)]);
      run('networksetup', ['-setwebproxystate', svc, 'on']);
      run('networksetup', ['-setsecurewebproxystate', svc, 'on']);
      run('networksetup', ['-setproxybypassdomains', svc, ...BYPASS_DOMAINS]);
    }
    ok(`macOS 系统代理已开启（${list.length} 个网络服务 → 127.0.0.1:${proxyPort}）`);
    return { services: list, port: proxyPort };
  }
  for (const svc of list) {
    run('networksetup', ['-setwebproxystate', svc, 'off']);
    run('networksetup', ['-setsecurewebproxystate', svc, 'off']);
  }
  fs.rmSync(p.proxyBackup, { force: true });
  ok('macOS 系统代理已关闭');
  return { services: list, cleared: true };
}

function linuxSystemProxy(action, dir, proxyPort) {
  const hasGsettings = !!which('gsettings');
  if (action === 'get') {
    const r = hasGsettings ? run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']) : { stdout: '' };
    return { backend: hasGsettings ? 'gsettings' : 'none', mode: r.stdout.trim() };
  }
  const p = paths(dir);
  if (action === 'set') {
    if (hasGsettings) {
      if (!fs.existsSync(p.proxyBackup)) {
        fs.writeFileSync(p.proxyBackup, JSON.stringify({
          mode: run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']).stdout.trim(),
        }, null, 2));
      }
      for (const scheme of ['http', 'https']) {
        run('gsettings', ['set', `org.gnome.system.proxy.${scheme}`, 'host', '127.0.0.1']);
        run('gsettings', ['set', `org.gnome.system.proxy.${scheme}`, 'port', String(proxyPort)]);
      }
      run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
      ok(`Linux(GNOME) 系统代理已开启 → 127.0.0.1:${proxyPort}`);
    } else {
      const envFile = path.join(dir, 'proxy.env');
      fs.writeFileSync(envFile, `export http_proxy=http://127.0.0.1:${proxyPort}\nexport https_proxy=http://127.0.0.1:${proxyPort}\nexport all_proxy=socks5://127.0.0.1:${proxyPort}\nexport no_proxy=localhost,127.0.0.1,::1\n`);
      warn('未找到 gsettings（非 GNOME 桌面），已写入 proxy.env');
      log(`  ${c.cyan(`source ${envFile}`)}  # 在当前 shell 生效`);
    }
    return { backend: hasGsettings ? 'gsettings' : 'file', port: proxyPort };
  }
  if (hasGsettings) {
    run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none']);
    fs.rmSync(p.proxyBackup, { force: true });
    ok('Linux(GNOME) 系统代理已关闭');
  }
  return { cleared: true };
}

// ---------------------------------------------------------------------------
// 连通性验证
// ---------------------------------------------------------------------------
function parseHttp(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx + 4) : '';
  const status = Number((head.match(/^HTTP\/\d\.\d (\d+)/) || [])[1] || 0);
  return { status, body, head };
}

export function httpViaProxy(proxyPort, url, { timeoutMs = 10000 } = {}) {
  const u = new URL(url);
  if (u.protocol === 'http:') {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: url,
          headers: { Host: u.host, 'User-Agent': 'vpn-skill', Connection: 'close' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { body += d; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });
  }
  // https：先 CONNECT 打隧道，再在隧道里跑 TLS（这才是浏览器真实走的路）
  return new Promise((resolve, reject) => {
    const target = `${u.hostname}:${u.port || 443}`;
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
      headers: { Host: target, 'User-Agent': 'vpn-skill' },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`CONNECT 超时 ${timeoutMs}ms`)));
    req.on('error', reject);
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`));
      const t = tls.connect({ socket, servername: u.hostname }, () => {
        t.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: vpn-skill\r\nConnection: close\r\n\r\n`);
      });
      let raw = '';
      t.setEncoding('utf8');
      t.on('data', (d) => { raw += d; });
      t.on('end', () => resolve(parseHttp(raw)));
      t.on('error', reject);
    });
    req.end();
  });
}

async function directFetch(url, timeoutMs = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  return { status: res.status, body: await res.text() };
}

// 出口 IP 服务：单一服务在部分网络下会被墙/限流，按可用性依次降级
const IP_PROVIDERS = [
  { name: 'api.ipify.org', url: 'https://api.ipify.org/?format=json', pick: (j, t) => j?.ip || t.trim() },
  { name: 'api.myip.com', url: 'https://api.myip.com', pick: (j) => j?.ip, country: (j) => j?.country },
  { name: 'ipinfo.io', url: 'https://ipinfo.io/json', pick: (j) => j?.ip, country: (j) => j?.country },
  { name: 'ifconfig.me', url: 'https://ifconfig.me/all.json', pick: (j) => j?.ip_addr },
  { name: 'ip-api.com', url: 'http://ip-api.com/json/?fields=status,country,countryCode,query', pick: (j) => j?.query, country: (j) => j?.country },
];

async function lookupExitIp(getBody, timeoutMs) {
  let lastErr = null;
  for (const p of IP_PROVIDERS) {
    try {
      const body = await getBody(p.url, timeoutMs);
      let j = null;
      const text = typeof body === 'string' ? body : body?.body ?? '';
      try { j = JSON.parse(text); } catch { /* 纯文本响应 */ }
      const ip = p.pick(j, text);
      if (ip && /^[0-9a-fA-F.:]+$/.test(String(ip).trim())) {
        return { ip: String(ip).trim(), country: p.country?.(j) || '', provider: p.name };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有出口 IP 服务均不可用');
}

export async function verifyProxy(dir, opts = {}) {
  const meta = readMeta(dir);
  if (!meta) throw new Error('未安装客户端');
  const port = meta.proxyPort;
  const timeoutMs = opts.timeoutMs || 12000;
  const out = { port, checks: [] };

  // 1. 代理端口通不通（generate_204）。gstatic 在国内直连基本不可达，
  //    因此拿到 204 本身就是「流量确实过了代理」的强证据。
  const t0 = Date.now();
  try {
    const r = await httpViaProxy(port, 'https://www.gstatic.com/generate_204', { timeoutMs });
    out.latencyMs = Date.now() - t0;
    out.checks.push({ name: 'HTTPS 隧道 (gstatic/generate_204)', ok: r.status === 204, detail: `HTTP ${r.status} · ${out.latencyMs}ms` });
  } catch (e) {
    out.checks.push({ name: 'HTTPS 隧道 (gstatic/generate_204)', ok: false, detail: e.message });
  }

  // 2. 出口 IP（走代理）
  try {
    const r = await lookupExitIp((u, t) => httpViaProxy(port, u, { timeoutMs: t }), timeoutMs);
    out.exitIp = r.ip;
    out.exitCountry = r.country;
    out.exitProvider = r.provider;
    out.checks.push({ name: '出口 IP', ok: true, detail: `${r.ip}${r.country ? ` (${r.country})` : ''} via ${r.provider}` });
  } catch (e) {
    out.checks.push({ name: '出口 IP', ok: false, detail: e.message });
  }

  // 3. 直连对照（判断是否真的换了出口；直连不通属正常，不算失败）
  try {
    const r = await lookupExitIp(async (u) => (await directFetch(u, 6000)).body, 6000);
    out.directIp = r.ip;
    out.directCountry = r.country;
  } catch { /* 忽略 */ }

  out.behindProxy = !!(out.exitIp && out.directIp && out.exitIp !== out.directIp);
  out.ok = out.checks.every((x) => x.ok);
  return out;
}

export function verifyReport(v) {
  for (const chk of v.checks) {
    (chk.ok ? ok : fail)(`${chk.name}: ${chk.detail}`);
  }
  if (v.exitIp) {
    const same = v.directIp && v.exitIp === v.directIp;
    log(
      `  出口 IP: ${c.yellow(v.exitIp)}${v.exitCountry ? ` (${v.exitCountry})` : ''}` +
        (v.directIp ? c.dim(`  ·  直连 IP: ${v.directIp}${same ? ' ⚠ 与出口相同，可能没走代理' : ''}`) : ''),
    );
  }
  if (v.latencyMs) log(`  代理往返: ${c.yellow(v.latencyMs + 'ms')}`);
}
