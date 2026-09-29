#!/usr/bin/env node
// vpn-skill :: bin/vpn.mjs
// 只要给我海外服务器的登录方式 —— 部署服务端、装本机客户端、连上、验证，一条命令。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  c, log, info, ok, warn, fail, die, banner, parseArgv, ensureDir, localStateDir, run,
} from '../src/util.mjs';
import { normalizeState, validateState, buildLink, printStateCfgHelp, SUPPORTED } from '../src/protocols.mjs';
import { deploy, serverCommand, parseStateEnv } from '../src/deploy.mjs';
import {
  installClient, startClient, stopClient, clientStatus, setSystemProxy, clearSystemProxy,
  getSystemProxy, verifyProxy, verifyReport, readMeta, writeMeta, paths, DEFAULT_PROXY_PORT,
} from '../src/client.mjs';
import { pinned } from '../src/download.mjs';

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  } catch { return '0.0.0'; }
})();

const USAGE = `
${c.bold('vpn-skill')} v${VERSION} — 自建 VPN 一键部署 + 本机客户端自动连接

${c.bold('用法')}
  vpn-skill setup   --host <IP> [--user root] (--password <pw> | --key <pem>) [选项]   ${c.dim('# 一条命令搞定：部署 + 装客户端 + 连接 + 验证')}
  vpn-skill deploy  --host <IP> [登录参数] [选项]                                      ${c.dim('# 只部署服务端，输出配置与分享链接')}
  vpn-skill client  --state <file>|--dir <dir> [选项]                                  ${c.dim('# 只装/更新本机客户端')}
  vpn-skill up | down | status | verify | link                                        ${c.dim('# 连接 / 断开 / 状态 / 验证 / 拿链接')}
  vpn-skill server  <status|logs|restart|uninstall> --host <IP> [登录参数]              ${c.dim('# 服务端运维')}
  vpn-skill doctor                                                                     ${c.dim('# 本机环境自检')}

${c.bold('登录参数')}
  --host <ip>            服务器地址（必填）
  --port <n>             SSH 端口（默认 22）
  --user <name>          SSH 用户（默认 root）
  --password <pw>        SSH 密码（或 sudo 密码）
  --key <path>           SSH 私钥文件
  --sudo-password <pw>   非 root 登录时用于 sudo 提权

${c.bold('部署选项')}
  --protocol <p>         hy2(默认) | ss | reality
  --vpn-port <n>         服务监听端口（默认随机；reality 默认优先 443）
  --server-ip <ip>       服务器对外 IP/域名（NAT 环境必须指定）
  --sni <domain>         hy2 伪装 SNI（默认 bing.com）/ reality 伪装域名
  --reality-dest <h:p>   reality 回落目标（默认 www.microsoft.com:443）
  --method <m>           SS 加密方式（默认 aes-128-gcm）
  --tag <name>           节点显示名
  --no-bbr               跳过 BBR 内核优化
  --no-firewall          跳过防火墙自动放行
  --force                强制重装（默认复用已有配置，不会改动已下发的密码/端口）
  --dry-run              远端只做「配置生成」演练，不装二进制、不启服务

${c.bold('客户端选项')}
  --dir <path>           客户端目录（默认 ${localStateDir()}）
  --proxy-port <n>       本地混合端口（默认 ${DEFAULT_PROXY_PORT}）
  --tun                  启用 TUN 全局代理（Windows 需管理员 + wintun）
  --no-system-proxy      不自动设置系统代理
  --no-verify            跳过连通性验证

${c.bold('示例')}
  ${c.dim('# 最常用：Hysteria2 全自动')}
  npx vpn-skill setup --host 203.0.113.10 --user root --password 'YourPwd!'
  ${c.dim('# 隐蔽性优先：VLESS + Reality')}
  npx vpn-skill setup --host 203.0.113.10 --key ~/.ssh/id_ed25519 --protocol reality
  ${c.dim('# 只部署服务端，把链接导到手机')}
  npx vpn-skill deploy --host 1.2.3.4 --password pw --protocol ss
`;

const BOOL_FLAGS = ['help', 'version', 'force', 'dry-run', 'tun', 'no-system-proxy', 'no-verify', 'no-bbr', 'no-firewall', 'json', 'yes', 'quiet'];
const ALIASES = { h: 'help', v: 'version', n: 'no-system-proxy', f: 'force' };

function need(args, key, msg) {
  if (!args[key]) die(msg);
  return args[key];
}

function connOptsFrom(args) {
  if (!args.host) die('缺少 --host <服务器IP>\n\n' + USAGE);
  return {
    host: args.host,
    port: args.port ? Number(args.port) : 22,
    username: args.user, // 交给 resolveConn：~/.ssh/config 的 User 优先于硬编码默认值
    password: args.password,
    key: args.key || args['identity-file'],
    passphrase: args.passphrase,
  };
}

function clientDir(args) {
  return path.resolve(args.dir || localStateDir());
}

function loadLocalState(dir) {
  const meta = readMeta(dir);
  if (!meta?.state) die(`本地没有已安装的客户端（${dir}）。先执行 vpn-skill setup 或 client。`);
  return { meta, state: normalizeState(meta.state) };
}

function saveStateFile(dir, state, raw) {
  const f = path.join(dir, 'state.env');
  if (raw) fs.writeFileSync(f, Object.entries(raw).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
  return f;
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------
async function cmdDeploy(args) {
  const protocol = (args.protocol || 'hy2').toLowerCase();
  banner(`vpn-skill · 服务端部署（${protocol}）`);
  const result = await deploy(connOptsFrom(args), {
    protocol,
    vpnPort: args['vpn-port'],
    serverIp: args['server-ip'],
    vpnPassword: args['vpn-password'],
    sni: args.sni,
    realityDest: args['reality-dest'],
    method: args.method,
    uuid: args.uuid,
    tag: args.tag,
    stateDir: args['state-dir'],
    confDir: args['conf-dir'],
    workdir: args.workdir,
    force: !!args.force,
    dryRun: !!args['dry-run'],
    bbr: !args['no-bbr'],
    firewall: !args['no-firewall'],
    sudoPassword: args['sudo-password'],
  });

  const dir = clientDir(args);
  ensureDir(dir);
  saveStateFile(dir, result.state, result.raw);
  fs.writeFileSync(path.join(dir, 'server-info.json'), JSON.stringify({
    ...result.probe, usedSudo: result.usedSudo, deployedAt: Math.floor(Date.now() / 1000),
  }, null, 2));
  const meta = readMeta(dir) || {};
  meta.state = result.state.raw || result.state;
  meta.link = buildLink(result.state);
  writeMeta(dir, meta);

  log('');
  ok(`配置已保存到本地 ${path.join(dir, 'state.env')}（便于后续 vpn-skill client / up）`);
  printLink(result.state);
  if (args.json) log(JSON.stringify(result.state.raw, null, 2));
  return result.state;
}

function printLink(state) {
  log('');
  log(c.bold('  客户端连接信息'));
  log(`  协议   : ${c.yellow(state.protocol)}`);
  log(`  服务器 : ${c.yellow(state.host)}:${c.yellow(String(state.port))}`);
  if (state.protocol === 'hy2') log(`  密码   : ${c.yellow(state.password)}   SNI: ${c.yellow(state.sni)}`);
  if (state.protocol === 'ss') log(`  密码   : ${c.yellow(state.password)}   加密: ${c.yellow(state.method)}`);
  if (state.protocol === 'reality') {
    log(`  UUID   : ${c.yellow(state.uuid)}`);
    log(`  公钥   : ${c.yellow(state.publicKey)}   shortId: ${c.yellow(state.shortId)}`);
    log(`  伪装   : ${c.yellow(state.sni)}`);
  }
  const link = buildLink(state);
  if (link) log(`  分享链接: ${c.green(link)}`);
  printStateCfgHelp(state.protocol);
  log('');
}

async function cmdClient(args, state) {
  const dir = clientDir(args);
  banner('vpn-skill · 本机客户端安装');
  const p = await installClient(state, {
    dir,
    proxyPort: args['proxy-port'],
    controllerPort: args['controller-port'],
    tun: !!args.tun,
    force: !!args.force,
  });
  return p;
}

async function cmdUp(args, stateHint) {
  const dir = clientDir(args);
  let state = stateHint;
  if (!state) {
    if (args.state) {
      const raw = parseStateEnv(fs.readFileSync(path.resolve(args.state), 'utf8'));
      state = normalizeState(raw);
    } else {
      state = loadLocalState(dir).state;
    }
  }
  banner('vpn-skill · 连接');
  const inst = await installClient(state, {
    dir,
    proxyPort: args['proxy-port'],
    controllerPort: args['controller-port'],
    tun: !!args.tun,
    force: false,
  });
  await startClient(dir);
  if (!args['no-system-proxy']) {
    const applied = await setSystemProxy(dir);
    ok(`系统代理已设置为 127.0.0.1:${inst.proxyPort}`);
    if (args.json) log(JSON.stringify(applied, null, 2));
  } else {
    info(`已跳过系统代理。手工使用: ${c.cyan(`http://127.0.0.1:${inst.proxyPort}`)}（HTTP/SOCKS5 同端口）`);
  }
  if (!args['no-verify']) {
    log('');
    info('验证出网…');
    const v = await verifyProxy(dir).catch((e) => ({ ok: false, checks: [{ name: '验证', ok: false, detail: e.message }] }));
    verifyReport(v);
    if (!v.ok) {
      warn('验证未通过。排查建议：');
      log('  1) 云安全组是否放行服务端口（UDP/TCP）');
      log('  2) ' + c.cyan(`tail -n 50 ${path.join(dir, 'mihomo.log')}`));
      log('  3) ' + c.cyan(`vpn-skill server logs --host ${state.host} --user <user> --password <pw>`));
    }
    if (args.json) log(JSON.stringify(v, null, 2));
  }
  return inst;
}

async function cmdDown(args) {
  const dir = clientDir(args);
  banner('vpn-skill · 断开');
  await clearSystemProxy(dir);
  await stopClient(dir);
  ok('已断开：系统代理已还原，mihomo 已停止');
}

async function cmdStatus(args) {
  const dir = clientDir(args);
  const st = await clientStatus(dir);
  banner('vpn-skill · 本机状态');
  if (!st.installed) {
    warn(`尚未安装客户端（目录 ${dir}）`);
    return st;
  }
  log(`  协议     : ${c.yellow(st.protocol || '?')} → ${c.yellow(String(st.host || '?'))}`);
  log(`  混合端口 : ${c.yellow(String(st.port))}   (HTTP / SOCKS5 同端口)`);
  log(`  TUN 模式 : ${st.tun ? c.green('已启用') : '未启用'}`);
  log(`  进程     : ${st.running ? c.green(`运行中 (pid ${st.pid})`) : c.red('未运行')}`);
  if (st.controller) log(`  内核版本 : ${c.dim(st.controller.version || '?')}`);
  const sys = await getSystemProxy(dir).catch(() => null);
  if (sys) {
    const on = sys.ProxyEnable === 1 || sys.mode === 'manual' || (sys.raw && /Enabled: Yes/.test(sys.raw));
    log(`  系统代理 : ${on ? c.green('已开启') : c.dim('未开启')}`);
  }
  if (!st.running && st.logTail) {
    log(c.dim('  ---- 日志尾部 ----'));
    log(c.dim(st.logTail));
  }
  if (args.json) log(JSON.stringify(st, null, 2));
  return st;
}

async function cmdVerify(args) {
  const dir = clientDir(args);
  banner('vpn-skill · 连通性验证');
  const v = await verifyProxy(dir, { timeoutMs: args.timeout ? Number(args.timeout) : undefined });
  verifyReport(v);
  if (args.json) log(JSON.stringify(v, null, 2));
  if (!v.ok) process.exitCode = 2;
  return v;
}

async function cmdLink(args) {
  const dir = clientDir(args);
  const { state } = loadLocalState(dir);
  const link = buildLink(state);
  if (args.json) {
    log(JSON.stringify({ link, subscription: path.join(dir, 'subscription.yaml'), state: state.raw }, null, 2));
    return;
  }
  log(link);
  log('');
  info(`订阅文件: ${path.join(dir, 'subscription.yaml')}（导入 Clash Verge / ClashX / Stash）`);
  info(`二维码可用手机客户端扫码导入，或直接把上面的链接粘进去`);
}

async function cmdServer(args) {
  const action = args._[1];
  if (!action) die('用法: vpn-skill server <status|logs|restart|uninstall> --host <IP> [登录参数]');
  const r = await serverCommand(connOptsFrom(args), action, {
    unit: args.unit,
    lines: args.lines,
    sudoPassword: args['sudo-password'],
  });
  if (action === 'status') {
    banner('vpn-skill · 服务端状态');
    if (!Object.keys(r.state).length) warn('服务端未找到 vpn-skill 状态文件');
    for (const [k, v] of Object.entries(r.state)) log(`  ${k} = ${v}`);
    log('');
    for (const [k, v] of Object.entries(r.units)) {
      log(`  ${k.padEnd(20)} ${v === 'active' ? c.green(v) : c.dim(v)}`);
    }
  } else if (action === 'logs') {
    log(r.logs);
  } else {
    log(r.out || `exit ${r.code}`);
  }
  return r;
}

async function cmdDoctor(args) {
  banner('vpn-skill · 环境自检');
  const checks = [];
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  checks.push(['Node.js >= 18', nodeOk, process.version]);
  let ssh2ok = false;
  try {
    await import('ssh2');
    ssh2ok = true;
  } catch { /* ignore */ }
  checks.push(['ssh2 依赖已安装', ssh2ok, ssh2ok ? 'ok' : '请在项目目录执行 npm install']);
  checks.push(['平台', true, `${process.platform}/${process.arch}`]);
  const dir = clientDir(args);
  checks.push(['客户端目录', fs.existsSync(dir), dir]);
  const binExe = paths(dir).bin;
  checks.push(['mihomo 内核', fs.existsSync(binExe), binExe]);
  if (fs.existsSync(binExe)) {
    const v = run(binExe, ['-v']);
    checks.push(['mihomo 可执行', v.code === 0, v.stdout.trim().split('\n')[0] || v.stderr.trim()]);
  }
  const meta = readMeta(dir);
  if (meta) {
    const st = await clientStatus(dir);
    checks.push(['本地代理端口', st.listening, String(meta.proxyPort)]);
  }
  let anyFail = false;
  for (const [name, good, detail] of checks) {
    (good ? ok : (anyFail = true, fail))(`${name}: ${detail}`);
  }
  log('');
  info(`固定版本: mihomo ${pinned('mihomo')} / hysteria ${pinned('hysteria')} / xray ${pinned('xray')} / ss-rust ${pinned('shadowsocks-rust')}`);
  info(`可用协议: ${SUPPORTED.join(' / ')}`);
  if (anyFail) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    log(USAGE);
    return;
  }
  const args = parseArgv(argv, { booleans: BOOL_FLAGS, aliases: ALIASES });
  const cmd = args._[0];

  if (args.help || cmd === 'help') {
    log(USAGE);
    return;
  }
  if (args.version || cmd === 'version') {
    log(VERSION);
    return;
  }

  switch (cmd) {
    case 'setup': {
      const state = await cmdDeploy(args);
      await cmdUp(args, state);
      log('');
      ok('全部完成 ✅  断开用 ' + c.cyan('vpn-skill down') + '，验证用 ' + c.cyan('vpn-skill verify'));
      break;
    }
    case 'deploy':
      await cmdDeploy(args);
      break;
    case 'client': {
      const dir = clientDir(args);
      let state;
      if (args.state) {
        state = normalizeState(parseStateEnv(fs.readFileSync(path.resolve(args.state), 'utf8')));
      } else {
        state = loadLocalState(dir).state;
      }
      const errs = validateState(state);
      if (errs.length) die(`状态文件无效: ${errs.join('; ')}`);
      await cmdClient(args, state);
      break;
    }
    case 'up':
    case 'connect':
      await cmdUp(args);
      break;
    case 'down':
    case 'disconnect':
    case 'stop':
      await cmdDown(args);
      break;
    case 'status':
      await cmdStatus(args);
      break;
    case 'verify':
    case 'test':
      await cmdVerify(args);
      break;
    case 'link':
    case 'url':
      await cmdLink(args);
      break;
    case 'server':
      await cmdServer(args);
      break;
    case 'doctor':
      await cmdDoctor(args);
      break;
    default:
      fail(`未知命令: ${cmd}`);
      log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log('');
  die(e && e.message ? e.message : String(e));
});
