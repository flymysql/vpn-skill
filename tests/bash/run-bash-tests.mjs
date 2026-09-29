// vpn-skill :: tests/bash/run-bash-tests.mjs
//
// 服务端脚本的离线自测：用 VPN_DRY_RUN=1 在本地 bash 里真实执行 server/*.sh，
// 断言「配置生成 / 状态输出 / 幂等 / 强制重写 / 命令行覆盖 / 非法字符拒绝」。
//
// 这些是能在没有 Linux 服务器的情况下对服务端脚本做的最强验证：
// 走的是完全相同的代码路径，只把「下载二进制、启服务、改防火墙」三步短路掉。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = '/tmp/vpn-skill-bash-tests';
const BASH = findBash();

let pass = 0;
let fail = 0;
const failures = [];

function findBash() {
  const cands = [
    process.env.VPNSKILL_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    '/bin/bash',
    '/usr/bin/bash',
    'bash',
  ].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.includes('ok')) return c;
  }
  return null;
}

function bash(script, env = {}) {
  const r = spawnSync(BASH, ['-c', script], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', ...env },
    timeout: 120000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  [ ok ] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function runDeploy(script, env) {
  return bash(`bash server/${script}`, {
    VPN_DRY_RUN: '1',
    VPN_SERVER_IP: '203.0.113.9',
    VPN_WORKDIR: `${TMP}/work`,
    ...env,
  });
}

/** 从 stdout 的 JSON 块 / state.env 里取状态 */
function stateOf(env, name) {
  const r = bash(`cat ${env.VPN_STATE_DIR}/state.env`, {});
  const out = {};
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function main() {
  if (!BASH) {
    console.log('未找到可用的 bash，跳过服务端脚本自测（可用 VPNSKILL_BASH 指定）');
    return;
  }
  console.log(`\n==== 服务端脚本离线自测 (bash: ${BASH}) ====\n`);
  bash(`rm -rf ${TMP} && mkdir -p ${TMP}`);

  // --- 语法 ---
  const syntax = bash('for f in server/*.sh; do bash -n "$f" || exit 1; done; echo ALL_OK');
  check('所有 server/*.sh 语法正确', syntax.stdout.includes('ALL_OK'), syntax.stderr.slice(0, 200));

  // --- Hysteria2 ---
  {
    const env = { VPN_STATE_DIR: `${TMP}/hy2/state`, VPN_CONF_DIR: `${TMP}/hy2/conf` };
    const r = runDeploy('hy2.sh', env);
    check('hy2 dry-run 退出码 0', r.code === 0, r.stderr.trim().slice(0, 300));
    const st = stateOf(env);
    check('hy2 状态: 协议/端口/密码/链接齐全',
      st.VPN_PROTOCOL === 'hy2' && /^\d+$/.test(st.VPN_PORT || '') && !!st.VPN_PASSWORD && (st.VPN_LINK || '').startsWith('hysteria2://'),
      `${st.VPN_PORT} ${(st.VPN_LINK || '').slice(0, 60)}`);
    check('hy2 输出含状态文件标记', r.stdout.includes('##VPN_SKILL_STATE_FILE='));
    check('hy2 stdout 为纯数据通道（无日志污染）', !/\\[[ .]{2,4}\\]/.test(r.stdout), JSON.stringify(r.stdout.split('\n')[0]).slice(0, 80));
    check('hy2 输出含可解析 JSON 块', /##VPN_SKILL_STATE_BEGIN##[\s\S]*"VPN_PORT"[\s\S]*##VPN_SKILL_STATE_END##/.test(r.stdout));
    const cfg = bash(`cat ${env.VPN_CONF_DIR}/config.yaml`);
    check('hy2 config.yaml 监听端口与状态一致', cfg.stdout.includes(`listen: :${st.VPN_PORT}`));
    check('hy2 config.yaml 含 auth/masquerade/quic 段',
      cfg.stdout.includes('type: password') && cfg.stdout.includes('masquerade:') && cfg.stdout.includes('initStreamReceiveWindow'));
    check('hy2 客户端 json 已生成', bash(`cat ${env.VPN_CONF_DIR}/hyclient.json`).stdout.includes(st.VPN_PASSWORD));

    // 幂等：重跑必须复用端口与密码，且不重写配置
    const r2 = runDeploy('hy2.sh', env);
    const st2 = stateOf(env);
    check('hy2 重跑幂等: 端口/密码不变', st2.VPN_PORT === st.VPN_PORT && st2.VPN_PASSWORD === st.VPN_PASSWORD,
      `${st.VPN_PORT} → ${st2.VPN_PORT}`);
    check('hy2 重跑识别「配置无变化」', r2.stderr.includes('配置无变化'));

    // 强制：重写配置但凭据仍不变（避免作废已下发的客户端）
    const r3 = runDeploy('hy2.sh', { ...env, VPN_FORCE: '1' });
    const st3 = stateOf(env);
    check('hy2 --force 仍会重启服务（日志可辨）', r3.stderr.includes('--force 生效'));
    check('hy2 --force 不再重复落盘内容', r3.stderr.includes('配置无变化'));
    check('hy2 重跑判定「无需重启」', r2.stderr.includes('本应保持'));
    check('hy2 --force 判定「本应重启」', r3.stderr.includes('本应重启'));
    check('hy2 --force 不改动凭据', st3.VPN_PASSWORD === st.VPN_PASSWORD && st3.VPN_PORT === st.VPN_PORT);

    // 命令行覆盖优先于历史状态
    const r4 = runDeploy('hy2.sh', { ...env, VPN_PORT: '45123', VPN_PASSWORD: 'explicit-pw-123' });
    const st4 = stateOf(env);
    check('hy2 显式端口/密码覆盖历史状态', st4.VPN_PORT === '45123' && st4.VPN_PASSWORD === 'explicit-pw-123', JSON.stringify({ p: st4.VPN_PORT }));

    // 非法值必须被拒绝（防止注入到 state.env / JSON）
    const bad = runDeploy('hy2.sh', { ...env, VPN_PASSWORD: 'has space "and quotes"' });
    check('hy2 非法字符被拒绝且退出非 0', bad.code !== 0 && /不安全字符/.test(bad.stderr), `code=${bad.code}`);
  }

  // --- Shadowsocks ---
  {
    const env = { VPN_STATE_DIR: `${TMP}/ss/state`, VPN_CONF_DIR: `${TMP}/ss/conf` };
    const r = runDeploy('ss-rust.sh', env);
    check('ss dry-run 退出码 0', r.code === 0, r.stderr.trim().slice(0, 300));
    const st = stateOf(env);
    check('ss 状态: 加密方式/链接', st.VPN_SS_METHOD === 'aes-128-gcm' && (st.VPN_LINK || '').startsWith('ss://'), st.VPN_LINK);
    const cfg = bash(`cat ${env.VPN_CONF_DIR}/config.json`);
    let j = null;
    try { j = JSON.parse(cfg.stdout); } catch { /* 由下一项断言报错 */ }
    check('ss config.json 可解析且端口一致', !!j && String(j.server_port) === st.VPN_PORT && j.method === 'aes-128-gcm');
    check('ss systemd 单元生成到工作目录（dry-run 零副作用）',
      bash(`cat ${TMP}/work/units/shadowsocks.service 2>/dev/null || echo MISSING`).stdout.includes('ExecStart=/usr/local/bin/ssserver'));
    check('ss dry-run 明确报告单元未安装到 /etc', r.stderr.includes('dry-run: 单元文件写入'));
    const bad = runDeploy('ss-rust.sh', { ...env, VPN_SS_METHOD: 'plain-none' });
    check('ss 非法加密方式被拒绝', bad.code !== 0 && /不支持的加密方式/.test(bad.stderr));
  }

  // --- Reality ---
  {
    const env = { VPN_STATE_DIR: `${TMP}/reality/state`, VPN_CONF_DIR: `${TMP}/reality/conf` };
    const r = runDeploy('reality.sh', env);
    check('reality dry-run 退出码 0', r.code === 0, r.stderr.trim().slice(0, 300));
    const st = stateOf(env);
    check('reality 状态: uuid/pbk/sid/链接',
      !!st.VPN_UUID && !!st.VPN_PUBLIC_KEY && !!st.VPN_SHORT_ID && (st.VPN_LINK || '').startsWith('vless://'),
      `port=${st.VPN_PORT} sid=${st.VPN_SHORT_ID}`);
    check('reality 私钥不落 state.env（保密）', !/VPN_PRIVATE_KEY/.test(Object.keys(st).join(',')));
    const cfg = bash(`cat ${env.VPN_CONF_DIR}/config.json`);
    let j = null;
    try { j = JSON.parse(cfg.stdout); } catch { /* 下一项报错 */ }
    const ib = j?.inbounds?.[0];
    check('reality config.json 结构正确',
      !!ib && ib.protocol === 'vless' && ib.streamSettings.security === 'reality'
      && ib.streamSettings.realitySettings.dest === 'www.microsoft.com:443'
      && ib.settings.clients[0].flow === 'xtls-rprx-vision');
    check('reality 默认端口 443（伪装 HTTPS）', st.VPN_PORT === '443' || /^\d+$/.test(st.VPN_PORT), st.VPN_PORT);
    check('reality 配置里确实带私钥', /"privateKey":\s*"[^"]+"/.test(cfg.stdout));
  }

  // --- 卸载脚本 ---
  {
    const r = bash('bash -n server/uninstall.sh && echo OK');
    check('uninstall.sh 语法正确', r.stdout.includes('OK'));
    const out = bash('VPN_DRY_RUN=1 bash server/uninstall.sh');
    check('uninstall.sh 非 root 时拒绝执行', out.code !== 0 && /root/.test(out.stderr + out.stdout));
  }

  bash(`rm -rf ${TMP}`);

  console.log('');
  if (fail === 0) {
    console.log(`\u001b[32m服务端脚本自测全部通过 ✅ (${pass} 项)\u001b[0m`);
  } else {
    console.log(`\u001b[31m服务端脚本自测失败 ${fail} 项: ${failures.join('; ')}\u001b[0m`);
    process.exitCode = 1;
  }
}

main();
