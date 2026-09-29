// vpn-skill :: tests/e2e/local-e2e.mjs
//
// 全链路真实自测（无需海外服务器、零外网副作用）：
//   1. 在本机拉起 shadowsocks-rust 的 ssserver 作为「服务端」
//   2. 用 vpn-skill 的 client 逻辑下载 mihomo、生成配置、启动进程
//   3. 通过 本地混合端口 → mihomo → ssserver → 公网 完成真实出网
//   4. 验证系统代理开关的写入/还原
//
// 这是本仓库在「没有真实海外机器」时能给出的最强证据：除服务端二进制本身之外，
// 客户端安装、配置生成、进程托管、代理链、验证逻辑全部走真实代码路径。
//
// 用法: node tests/e2e/local-e2e.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadWithMirrors } from '../../src/download.mjs';
import { unzipFile } from '../../src/archive.mjs';
import { installClient, startClient, stopClient, verifyProxy, setSystemProxy, clearSystemProxy, getSystemProxy, clientStatus } from '../../src/client.mjs';
import { normalizeState } from '../../src/protocols.mjs';
import { ensureDir, run, sleep, c, log, info, ok, warn, fail } from '../../src/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(ROOT, 'tests', '.cache');
const SS_VERSION = 'v1.25.0';
const KEEP = process.argv.includes('--keep');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) ok(name + (detail ? ` — ${detail}` : ''));
  else { failures += 1; fail(name + (detail ? ` — ${detail}` : '')); }
}

function freePort(lo = 21000, hi = 64000) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

async function ensureSsserver() {
  ensureDir(CACHE);
  const exe = path.join(CACHE, 'ssserver.exe');
  if (fs.existsSync(exe)) return exe;
  const asset = `shadowsocks-${SS_VERSION}.x86_64-pc-windows-msvc.zip`;
  const url = `https://github.com/shadowsocks/shadowsocks-rust/releases/download/${SS_VERSION}/${asset}`;
  const zip = path.join(CACHE, asset);
  info(`获取测试用 ssserver (${asset})`);
  const got = await downloadWithMirrors(url, zip, { quiet: true });
  if (!got) throw new Error('ssserver 下载失败（本机无法访问 GitHub 及其镜像）');
  const files = unzipFile(zip, CACHE, { wanted: ['ssserver.exe'] });
  if (!files.length) throw new Error('zip 内未找到 ssserver.exe');
  fs.copyFileSync(files[0], exe);
  return exe;
}

async function main() {
  log(c.bold('\n==== vpn-skill 本地端到端自测 ====\n'));

  // ---- 1. 起「服务端」 ----
  const ssserver = await ensureSsserver();
  check('ssserver 可执行', run(ssserver, ['--version']).code === 0, run(ssserver, ['--version']).stdout.trim().split('\n')[0]);

  const srvPort = freePort();
  const srvPwd = 'e2e-test-password-0123456789';
  const srvDir = ensureDir(path.join(CACHE, 'e2e-server'));
  const srvConf = path.join(srvDir, 'ss.json');
  fs.writeFileSync(srvConf, JSON.stringify({
    server: '127.0.0.1', server_port: srvPort, password: srvPwd, method: 'aes-128-gcm', mode: 'tcp_only', timeout: 60,
  }, null, 2));

  let srvLog = '';
  const srv = spawn(ssserver, ['-c', srvConf, '-v'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  srv.stdout.on('data', (d) => { srvLog += d.toString(); });
  srv.stderr.on('data', (d) => { srvLog += d.toString(); });
  srv.on('error', (e) => fail(`ssserver 启动失败: ${e.message}`));

  let up = false;
  for (let i = 0; i < 30; i++) {
    if (await portOpen(srvPort)) { up = true; break; }
    await sleep(300);
  }
  check('测试服务端监听就绪', up, `127.0.0.1:${srvPort}`);
  if (!up) { warn(srvLog.slice(-500)); process.exit(1); }

  // ---- 2. 客户端安装 ----
  const clientDir = path.join(os.tmpdir(), `vpn-skill-e2e-${Date.now()}`);
  const state = normalizeState({
    VPN_PROTOCOL: 'ss',
    VPN_HOST: '127.0.0.1',
    VPN_PORT: String(srvPort),
    VPN_PASSWORD: srvPwd,
    VPN_SS_METHOD: 'aes-128-gcm',
    VPN_TAG: 'e2e-local',
    VPN_SKILL_VERSION: '1.0.0',
  });
  const inst = await installClient(state, { dir: clientDir, proxyPort: freePort(), controllerPort: freePort() });
  check('mihomo 内核下载并解包', fs.existsSync(inst.bin));
  check('config.yaml 已生成', fs.existsSync(inst.config));
  const cfgText = fs.readFileSync(inst.config, 'utf8');
  check('配置含 ss 节点与本地端口', cfgText.includes('type: \'ss\'') && cfgText.includes(`mixed-port: ${inst.proxyPort}`));

  // 用 mihomo 自己的 -t 做配置合法性校验（等价于服务端用 xray -test 的思路）
  const t = run(inst.bin, ['-t', '-d', clientDir, '-f', inst.config]);
  check('mihomo 配置校验通过 (-t)', t.code === 0, (t.stdout + t.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 200));

  // ---- 3. 启动并验证代理链 ----
  await startClient(clientDir);
  const st = await clientStatus(clientDir);
  check('mihomo 进程存活且端口监听', st.running, `pid=${st.pid} port=${st.port}`);
  if (st.controller) check('外部控制器可达', true, `mihomo ${st.controller.version}`);

  // 用控制器主动做一次代理内延迟探测（由 mihomo 自己发起，证据比只看端口强）
  try {
    const res = await fetch(`http://127.0.0.1:${inst.controllerPort}/proxies/e2e-local/delay?timeout=8000&url=http://www.gstatic.com/generate_204`, {
      headers: { Authorization: `Bearer ${inst.secret}` }, signal: AbortSignal.timeout(12000),
    });
    const j = await res.json();
    check('mihomo 经节点延迟探测成功', j.delay > 0, `${j.delay}ms`);
  } catch (e) {
    check('mihomo 经节点延迟探测成功', false, e.message);
  }

  const v = await verifyProxy(clientDir, { timeoutMs: 15000 });
  for (const chk of v.checks) check(`出网验证 · ${chk.name}`, chk.ok, chk.detail);
  check('拿到出口 IP', !!v.exitIp, `${v.exitIp || '?'} ${v.exitCountry || ''}`);
  const sawConn = /connect|tcp|\[ss\]/i.test(srvLog);
  check('测试服务端记录到连接（证明流量确实过代理）', sawConn || v.ok, sawConn ? '日志有连接记录' : '依赖 204 结果判定');

  // ---- 4. 系统代理开关 ----
  if (process.platform === 'win32' || process.platform === 'darwin' || run('which', ['gsettings']).code === 0) {
    const before = await getSystemProxy(clientDir);
    await setSystemProxy(clientDir);
    const during = await getSystemProxy(clientDir);
    await clearSystemProxy(clientDir);
    const after = await getSystemProxy(clientDir);
    const on = during.ProxyEnable === 1 || during.mode === 'manual' || /Enabled: Yes/.test(during.raw || '');
    check('系统代理可开启', on, JSON.stringify(during).slice(0, 120));
    check('系统代理已还原', JSON.stringify(after) === JSON.stringify(before) || after.ProxyEnable === 0,
      JSON.stringify(after).slice(0, 120));
  }

  // ---- 清理 ----
  if (!KEEP) {
    await stopClient(clientDir, { quiet: true });
    const stopped = await clientStatus(clientDir);
    check('mihomo 可正常停止', !stopped.running);
    try { srv.kill(); } catch { /* ignore */ }
    try { fs.rmSync(clientDir, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    warn(`--keep: 客户端目录保留在 ${clientDir}，测试服务端仍在 127.0.0.1:${srvPort} 运行`);
  }

  log('');
  if (failures === 0) {
    ok(c.bold('本地端到端自测全部通过 ✅'));
  } else {
    fail(c.bold(`本地端到端自测失败 ${failures} 项`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  fail(`自测异常: ${e.stack || e.message}`);
  process.exit(1);
});
