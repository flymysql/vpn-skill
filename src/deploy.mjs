// vpn-skill :: src/deploy.mjs
// 把 server/*.sh 推到目标机并以 root 身份非交互执行，再把状态回传本机。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, exec, execRoot, writeRemote, close, resolveConn } from './ssh.mjs';
import { normalizeState, validateState, SUPPORTED } from './protocols.mjs';
import { c, log, info, ok, warn, die, shq, which, run } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');

export function parseStateEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function buildEnvExports(env) {
  const lines = ['# 由 vpn-skill CLI 生成，供 server/*.sh 以非交互方式读取'];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`export ${k}=${shq(String(v))}`);
  }
  return lines.join('\n') + '\n';
}

/** 探测目标机能力（是否 root / 是否有 systemd / 发行版），用于给出准确的前置提示 */
export async function probeServer(conn) {
  const r = await exec(
    conn,
    [
      'echo "USER=$(id -un)"',
      'echo "UID=$(id -u)"',
      'echo "ARCH=$(uname -m)"',
      'echo "OS=$(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME)"',
      'echo "SYSTEMD=$( [ -d /run/systemd/system ] && echo yes || echo no )"',
      'command -v curl >/dev/null && echo "CURL=yes" || echo "CURL=no"',
      'command -v sudo >/dev/null && echo "SUDO=yes" || echo "SUDO=no"',
      'echo "QUIC=$( [ -f /proc/sys/net/ipv4/ip_forward ] && echo yes || echo no )"',
    ].join('; '),
    { timeoutMs: 20000 },
  );
  const out = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** 读取远端状态文件。
 *  用 cat 而不是 SFTP：非 root 登录 + sudo 提权时文件属于 root（0600），
 *  直接读会被拒；必须在同一提权通道下读。SFTP 在受限 sshd 上也常被禁。 */
async function readRemoteState(conn, remotePath, sudoPassword) {
  const plain = await exec(conn, `cat ${shq(remotePath)} 2>/dev/null`, { timeoutMs: 15000 });
  if (plain.stdout.includes('VPN_PROTOCOL=')) return { text: plain.stdout, method: 'cat' };
  try {
    const esc = await execRoot(conn, `cat ${shq(remotePath)}`, { password: sudoPassword, timeoutMs: 25000 });
    if (esc.stdout.includes('VPN_PROTOCOL=')) return { text: esc.stdout, method: 'sudo cat' };
  } catch { /* 无 sudo 权限时忽略，交给上层报错 */ }
  return null;
}

export async function deploy(connOpts, opts = {}) {
  const protocol = String(opts.protocol || 'hy2').toLowerCase();
  if (!SUPPORTED.includes(protocol)) die(`不支持的协议: ${protocol}（可选 ${SUPPORTED.join(' / ')}）`);

  const scriptName = { hy2: 'hy2.sh', ss: 'ss-rust.sh', reality: 'reality.sh' }[protocol];
  const localCommon = path.join(SERVER_DIR, 'common.sh');
  const localScript = path.join(SERVER_DIR, scriptName);
  if (!fs.existsSync(localScript)) die(`缺少服务端脚本: ${localScript}`);

  const remoteDir = `/tmp/vpn-skill-upload-${Date.now().toString(36)}`;
  info(`连接 ${connOpts.username}@${connOpts.host}:${connOpts.port || 22}`);
  const conn = await connect(connOpts);
  const t0 = Date.now();
  try {
    const probe = await probeServer(conn);
    ok(`目标机: ${probe.OS || 'unknown'} / ${probe.ARCH || '?'} / user=${probe.USER} / systemd=${probe.SYSTEMD}`);

    if (protocol === 'hy2' && probe.SYSTEMD !== 'yes' && opts.dryRun !== true) {
      warn('目标机没有 systemd，服务不会被托管（脚本会跳过 systemctl）');
    }

    const env = {
      VPN_DRY_RUN: opts.dryRun ? '1' : '',
      VPN_PORT: opts.vpnPort ? String(opts.vpnPort) : '',
      VPN_SERVER_IP: opts.serverIp || '',
      VPN_PASSWORD: opts.vpnPassword || '',
      VPN_SNI: opts.sni || '',
      VPN_REALITY_DEST: opts.realityDest || '',
      VPN_SS_METHOD: opts.method || '',
      VPN_UUID: opts.uuid || '',
      VPN_TAG: opts.tag || '',
      VPN_STATE_DIR: opts.stateDir || '',
      VPN_CONF_DIR: opts.confDir || '',
      VPN_WORKDIR: opts.workdir || '',
      VPN_FORCE: opts.force ? '1' : '',
      VPN_BBR: opts.bbr === false ? '0' : '',
      VPN_OPEN_FIREWALL: opts.firewall === false ? '0' : '',
    };

    await exec(conn, `mkdir -p ${remoteDir}`, { timeoutMs: 15000 });
    await writeRemote(conn, `${remoteDir}/common.sh`, fs.readFileSync(localCommon), 0o644);
    await writeRemote(conn, `${remoteDir}/${scriptName}`, fs.readFileSync(localScript), 0o644);
    await writeRemote(conn, `${remoteDir}/env.sh`, Buffer.from(buildEnvExports(env)), 0o600);
    ok(`已上传脚本到 ${remoteDir}`);

    const inner = `cd ${shq(remoteDir)} && set -a && . ./env.sh && set +a && bash ./${scriptName}`;
    log('');
    log(c.dim('---- 远端执行输出 ----'));
    const res = await execRoot(conn, inner, {
      password: opts.sudoPassword || connOpts.password,
      timeoutMs: opts.timeoutMs || 900000,
      onLine: (chunk) => process.stdout.write(chunk),
      // dry-run 只是演练配置生成，不必强求 root 提权
      fallbackToUser: opts.dryRun === true,
    });
    log(c.dim('---- 远端执行结束 ----'));
    log('');

    const marker = (res.stdout.match(/##VPN_SKILL_STATE_FILE=(.*?)##/) || [])[1];
    let stateText = null;
    if (marker) {
      const mp = marker.trim();
      const got = await readRemoteState(conn, mp, opts.sudoPassword || connOpts.password);
      if (got) {
        stateText = got.text;
        if (got.method !== 'cat') info(`状态文件通过「${got.method}」读取`);
      } else {
        warn(`未能读取状态文件: ${mp}`);
      }
    } else if (res.code === 0) {
      warn('未在输出中找到状态文件标记，尝试读取默认路径');
      for (const p of ['/etc/vpn-skill/state.env', '$HOME/.vpn-skill/state.env']) {
        const got = await readRemoteState(conn, p, opts.sudoPassword || connOpts.password);
        if (got) { stateText = got.text; break; }
      }
    }

    if (res.code !== 0) {
      const tail = res.stderr.trim().split('\n').slice(-10).join('\n');
      throw new Error(`远端部署失败（exit ${res.code}）${tail ? `\n${tail}` : ''}`);
    }
    if (!stateText) throw new Error('部署已执行但未能取回状态文件，无法继续安装客户端');

    const raw = parseStateEnv(stateText);
    const state = normalizeState(raw);
    const errs = validateState(state);
    if (errs.length) throw new Error(`远端状态不完整: ${errs.join('; ')}`);

    ok(`部署完成，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
    return { state, raw, probe, usedSudo: res.usedSudo, remoteDir };
  } finally {
    await close(conn);
  }
}

export async function serverCommand(connOpts, action, opts = {}) {
  const conn = await connect(connOpts);
  try {
    if (action === 'status') {
      const r = await exec(
        conn,
        [
          'cat /etc/vpn-skill/state.env 2>/dev/null || cat $HOME/.vpn-skill/state.env 2>/dev/null',
          'echo "---UNIT---"',
          'for u in hysteria-server shadowsocks xray; do printf "%s=%s\\n" "$u" "$(systemctl is-active $u 2>/dev/null || echo n/a)"; done',
        ].join('; '),
        { timeoutMs: 20000 },
      );
      const [stateText, rest] = r.stdout.split('---UNIT---');
      return { state: parseStateEnv(stateText || ''), units: parseStateEnv(rest || '') };
    }
    if (action === 'logs') {
      const unit = opts.unit || 'hysteria-server';
      const r = await exec(conn, `journalctl -u ${unit} -n ${opts.lines || 80} --no-pager 2>/dev/null || tail -n ${opts.lines || 80} /var/log/${unit}.log 2>/dev/null`, { timeoutMs: 30000 });
      return { logs: r.stdout };
    }
    if (action === 'restart') {
      const unit = opts.unit || 'hysteria-server';
      const r = await execRoot(conn, `systemctl restart ${unit} && sleep 1 && systemctl is-active ${unit}`, {
        password: opts.sudoPassword || connOpts.password,
        timeoutMs: 60000,
        onLine: (d) => process.stdout.write(d),
      });
      return { code: r.code, out: r.stdout.trim() };
    }
    if (action === 'uninstall') {
      const scriptPath = path.join(SERVER_DIR, 'uninstall.sh');
      const remoteDir = `/tmp/vpn-skill-uninstall-${Date.now().toString(36)}`;
      await exec(conn, `mkdir -p ${remoteDir}`, { timeoutMs: 15000 });
      await writeRemote(conn, `${remoteDir}/uninstall.sh`, fs.readFileSync(scriptPath), 0o644);
      const r = await execRoot(conn, `cd ${shq(remoteDir)} && bash ./uninstall.sh`, {
        password: opts.sudoPassword || connOpts.password,
        timeoutMs: 120000,
        onLine: (d) => process.stdout.write(d),
      });
      return { code: r.code, out: r.stdout.trim() };
    }
    throw new Error(`未知的 server 子命令: ${action}`);
  } finally {
    await close(conn);
  }
}
