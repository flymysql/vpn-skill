// vpn-skill :: tests/integration/ssh-deploy.mjs
//
// 真实 SSH 集成测试：验证「传输层 + 远端执行 + 状态回传 + 客户端装配」整条链路。
// 为了不在目标机上留下任何痕迹，远端统一用 VPN_DRY_RUN=1 且状态/配置目录都指向 /tmp，
// 不装二进制、不启服务、不动防火墙、不写 /etc。
//
// 目标机来自环境变量，缺省用本机已有的编译机；连不上就 SKIP（不判失败），便于 CI。
//   VPNSKILL_TEST_SSH_HOST / _PORT / _USER / _KEY
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { deploy } from '../../src/deploy.mjs';
import { installClient, startClient, stopClient, clientStatus } from '../../src/client.mjs';
import { connect, exec, close } from '../../src/ssh.mjs';
import { ensureDir, expandHome } from '../../src/util.mjs';

const HOST = process.env.VPNSKILL_TEST_SSH_HOST || '9.134.186.191';
const PORT = Number(process.env.VPNSKILL_TEST_SSH_PORT || 36000);
const USER = process.env.VPNSKILL_TEST_SSH_USER || 'jimmycppliu';
const KEY = process.env.VPNSKILL_TEST_SSH_KEY ? expandHome(process.env.VPNSKILL_TEST_SSH_KEY) : undefined; // 不指定就让 ~/.ssh/config 决定
const PROTO = process.env.VPNSKILL_TEST_PROTO || 'hy2';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  [ ok ] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

const remoteBase = `/tmp/vpn-skill-it-${Date.now().toString(36)}`;

async function main() {
  console.log(`\n==== SSH 集成测试 → ${USER}@${HOST}:${PORT} ====\n`);

  // 先探连通性，连不上直接 SKIP
  let conn;
  try {
    conn = await connect({ host: HOST, port: PORT, username: USER, key: KEY, timeoutMs: 12000 });
  } catch (e) {
    console.log(`  [skip] 无法连接测试目标机（${e.message}），跳过集成测试`);
    return;
  }
  await close(conn);

  try {
    const t0 = Date.now();
    const result = await deploy(
      { host: HOST, port: PORT, username: USER, key: KEY },
      {
        protocol: PROTO,
        dryRun: true,
        serverIp: '203.0.113.200',
        stateDir: `${remoteBase}/state`,
        confDir: `${remoteBase}/conf`,
        workdir: `${remoteBase}/work`,
        timeoutMs: 180000,
      },
    );
    check('SSH 连接 + 上传 + 远端执行成功', !!result.state, `用时 ${Math.round((Date.now() - t0) / 1000)}s`);
    check('远端探测到 Linux + 架构', !!result.probe.ARCH, `${result.probe.OS} / ${result.probe.ARCH}`);
    check('状态回传（用户指定 server-ip 生效）', result.state.host === '203.0.113.200', result.state.host);
    check('状态含协议/端口/链接',
      result.state.protocol === PROTO && result.state.port > 0 && !!result.state.link,
      `${result.state.protocol}:${result.state.port}`);
    check('执行身份符合预期（非 root 时按当前用户演练）', true, `usedSudo=${result.usedSudo}`);

    // 远端确实落了文件（证明 SFTP + 远端写盘都工作）
    const c2 = await connect({ host: HOST, port: PORT, username: USER, key: KEY, timeoutMs: 15000 });
    try {
      const ls = await exec(c2, `ls ${result.remoteDir} ${remoteBase}/state`, { timeoutMs: 15000 });
      check('远端残留文件可枚举（上传生效）', /common\.sh/.test(ls.stdout) && /state\.env/.test(ls.stdout));

      // 回归 #6：以 sudo 提权执行时，state.env 一度是 root:600，
      // 使本机 CLI 用普通账号读不回来 —— 表现为「部署成功却报失败」。
      if (result.usedSudo && result.usedSudo !== 'none(fallback)') {
        const st = await exec(c2, `stat -c '%U %a' ${remoteBase}/state/state.env`, { timeoutMs: 15000 });
        const [owner, mode] = st.stdout.trim().split(/\s+/);
        check('提权执行后状态文件属主已让回调用者（回归 #6）', owner === USER, `${owner} mode=${mode}`);
        check('状态文件权限仍为 600', mode === '600', mode);
      } else {
        check('提权执行后状态文件属主已让回调用者（回归 #6）', true, `本次未提权（usedSudo=${result.usedSudo}）`);
      }
    } finally {
      await close(c2);
    }

    // 用回传的状态在本机装一次客户端并启动（真实代码路径）
    const dir = ensureDir(path.join(os.tmpdir(), `vpn-skill-it-client-${Date.now()}`));
    const inst = await installClient(result.state, { dir, proxyPort: 17890 + (Date.now() % 500), controllerPort: 19090 });
    check('客户端配置由回传状态生成', fs.existsSync(inst.config));
    const cfg = fs.readFileSync(inst.config, 'utf8');
    check('配置指向目标机地址', cfg.includes('server: \'203.0.113.200\''));
    await startClient(dir, { quiet: true });
    const st = await clientStatus(dir);
    check('本机客户端可启动并监听', st.running, `port=${st.port}`);
    await stopClient(dir, { quiet: true });
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    const c3 = await connect({ host: HOST, port: PORT, username: USER, key: KEY, timeoutMs: 15000 }).catch(() => null);
    if (c3) {
      await exec(c3, `rm -rf ${remoteBase} /tmp/vpn-skill-upload-*`, { timeoutMs: 20000 }).catch(() => {});
      await close(c3);
      console.log(`  [ .. ] 已清理远端临时目录 ${remoteBase}`);
    }
  }

  console.log('');
  if (fail === 0) console.log(`\u001b[32mSSH 集成测试通过 ✅ (${pass} 项)\u001b[0m`);
  else { console.log(`\u001b[31mSSH 集成测试失败 ${fail} 项\u001b[0m`); process.exitCode = 1; }
}

main().catch((e) => {
  console.error(`集成测试异常: ${e.stack || e.message}`);
  process.exit(1);
});
