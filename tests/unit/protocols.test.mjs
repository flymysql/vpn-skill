// vpn-skill :: tests/unit/protocols.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toYaml, normalizeState, validateState, mihomoProxy, buildMihomoConfig, buildSubscription,
  buildLink, buildRules,
} from '../../src/protocols.mjs';
import { mihomoAsset, mirrorUrls } from '../../src/download.mjs';
import { parseStateEnv, buildEnvExports } from '../../src/deploy.mjs';
import { parseArgv, shq, isPort, humanAge } from '../../src/util.mjs';

const HY2 = normalizeState({
  VPN_PROTOCOL: 'hy2', VPN_HOST: '203.0.113.10', VPN_PORT: '23456',
  VPN_PASSWORD: 'p@ss-w0rd', VPN_SNI: 'bing.com', VPN_SKIP_CERT: '1', VPN_TAG: 'my-hy2',
});
const SS = normalizeState({
  VPN_PROTOCOL: 'ss', VPN_HOST: '198.51.100.7', VPN_PORT: '8388',
  VPN_PASSWORD: 'sspwd', VPN_SS_METHOD: 'aes-128-gcm', VPN_TAG: 'my-ss',
});
const REALITY = normalizeState({
  VPN_PROTOCOL: 'reality', VPN_HOST: '192.0.2.5', VPN_PORT: '443',
  VPN_UUID: '11111111-2222-3333-4444-555555555555', VPN_PUBLIC_KEY: 'PUBKEY+/=abc',
  VPN_SHORT_ID: 'deadbeef', VPN_SNI: 'www.microsoft.com', VPN_FLOW: 'xtls-rprx-vision',
  VPN_FP: 'chrome', VPN_TAG: 'my-reality',
});

test('toYaml: 标量/数组/对象', () => {
  const y = toYaml({ a: 1, b: true, c: 'x', d: ['p', 'q'], e: { f: 'g' }, h: [] });
  assert.match(y, /a: 1/);
  assert.match(y, /b: true/);
  assert.match(y, /c: 'x'/);
  assert.match(y, /d:\n  - 'p'\n  - 'q'/);
  assert.match(y, /e:\n  f: 'g'/);
  assert.match(y, /h: \[\]/);
});

test('toYaml: 单引号转义', () => {
  assert.match(toYaml({ k: "it's" }), /k: 'it''s'/);
});

test('normalizeState/validateState 正例与反例', () => {
  assert.deepEqual(validateState(HY2), []);
  assert.deepEqual(validateState(SS), []);
  assert.deepEqual(validateState(REALITY), []);
  assert.equal(validateState(normalizeState({ VPN_PROTOCOL: 'hy2', VPN_HOST: 'a' })).length, 2);
  assert.match(validateState(normalizeState({ VPN_PROTOCOL: 'bogus' }))[0], /未知协议/);
});

test('mihomoProxy: 三种协议字段正确', () => {
  assert.equal(mihomoProxy(HY2, 'n').type, 'hysteria2');
  assert.equal(mihomoProxy(HY2, 'n').password, 'p@ss-w0rd');
  assert.equal(mihomoProxy(HY2, 'n')['skip-cert-verify'], true);
  assert.equal(mihomoProxy(SS, 'n').cipher, 'aes-128-gcm');
  assert.equal(mihomoProxy(SS, 'n').udp, true);
  const r = mihomoProxy(REALITY, 'n');
  assert.equal(r.type, 'vless');
  assert.equal(r['reality-opts']['public-key'], 'PUBKEY+/=abc');
  assert.equal(r.flow, 'xtls-rprx-vision');
});

test('buildRules: 节点自身 IP 直连，兜底 MATCH,PROXY', () => {
  const rules = buildRules(HY2);
  assert.equal(rules[0], 'IP-CIDR,203.0.113.10/32,DIRECT,no-resolve');
  assert.equal(rules.at(-1), 'MATCH,PROXY');
  assert.ok(rules.includes('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve'));
});

test('buildMihomoConfig: 端口/节点/控制器/TUN 开关', () => {
  const cfg = buildMihomoConfig(HY2, { proxyPort: 7891, controllerPort: 9091, secret: 'SEC' });
  assert.match(cfg, /mixed-port: 7891/);
  assert.match(cfg, /external-controller: '127\.0\.0\.1:9091'/);
  assert.match(cfg, /type: 'hysteria2'/);
  assert.match(cfg, /allow-lan: false/);
  assert.match(cfg, /dns:\n  enable: false/);
  assert.ok(!cfg.includes('tun:'));
  const tun = buildMihomoConfig(HY2, { tun: true });
  assert.match(tun, /tun:/);
  assert.match(tun, /enhanced-mode: 'fake-ip'/);
});

test('buildSubscription: GUI 客户端订阅片段', () => {
  const sub = buildSubscription([HY2, SS]);
  assert.match(sub, /proxy-groups:/);
  assert.match(sub, /type: 'url-test'/);
  assert.match(sub, /type: 'hysteria2'/);
  assert.match(sub, /type: 'ss'/);
  assert.ok(!sub.includes('mixed-port'));
});

test('buildLink: 三种协议分享链接格式', () => {
  assert.equal(buildLink(HY2), 'hysteria2://p@ss-w0rd@203.0.113.10:23456/?insecure=1&sni=bing.com#my-hy2');
  assert.equal(buildLink(SS), `ss://${Buffer.from('aes-128-gcm:sspwd').toString('base64url')}@198.51.100.7:8388#my-ss`);
  const rl = buildLink(REALITY);
  assert.match(rl, /^vless:\/\/11111111-2222-3333-4444-555555555555@192\.0\.2\.5:443\?/);
  assert.match(rl, /security=reality/);
  assert.match(rl, /pbk=PUBKEY\+\/=abc/);
  assert.match(rl, /sid=deadbeef/);
  assert.ok(buildLink(normalizeState({ VPN_PROTOCOL: 'x' })) === '');
});

test('parseStateEnv: 注释/空行/等号值', () => {
  const s = parseStateEnv('# c\n\nVPN_A=1\nVPN_LINK=vless://x?a=1&b=2#t\nBAD_LINE\n=oops\n');
  assert.equal(s.VPN_A, '1');
  assert.equal(s.VPN_LINK, 'vless://x?a=1&b=2#t');
  assert.equal(Object.keys(s).length, 2);
});

test('buildEnvExports: 危险字符被正确转义', () => {
  const env = buildEnvExports({ VPN_PASSWORD: "a'b\"c $HOME `id`", VPN_EMPTY: '', VPN_PORT: 1234 });
  assert.ok(env.includes(`export VPN_PASSWORD='a'\\''b"c $HOME \`id\`'`));
  assert.ok(!env.includes('VPN_EMPTY'));
  assert.ok(env.includes('export VPN_PORT=\'1234\''));
});

test('mihomoAsset: 三端资产命名', () => {
  assert.deepEqual(mihomoAsset('win32', 'x64', 'v1.19.31'), { name: 'mihomo-windows-amd64-v1.19.31.zip', kind: 'zip' });
  assert.deepEqual(mihomoAsset('linux', 'x64', 'v1.19.31'), { name: 'mihomo-linux-amd64-v1.19.31.gz', kind: 'gz' });
  assert.deepEqual(mihomoAsset('darwin', 'arm64', 'v1.19.31'), { name: 'mihomo-darwin-arm64-v1.19.31.gz', kind: 'gz' });
  assert.equal(mihomoAsset('win32', 'ia32', 'v1').name, 'mihomo-windows-386-v1.zip');
});

test('mirrorUrls: 直连优先 + 环境变量镜像', () => {
  const urls = mirrorUrls('https://github.com/x/y');
  assert.equal(urls[0], 'https://github.com/x/y');
  assert.ok(urls.length > 1);
  process.env.VPN_MIRRORS = 'https://my.mirror/';
  const withEnv = mirrorUrls('https://github.com/x/y');
  assert.equal(withEnv[0], 'https://my.mirror/https://github.com/x/y');
  delete process.env.VPN_MIRRORS;
});

test('parseArgv: --k v / --k=v / 布尔 / 短别名', () => {
  const a = parseArgv(['setup', '--host', '1.2.3.4', '--port=2222', '--force', '--tun', '-h'], { booleans: ['force', 'tun', 'help'], aliases: { h: 'help' } });
  assert.equal(a._[0], 'setup');
  assert.equal(a.host, '1.2.3.4');
  assert.equal(a.port, '2222');
  assert.equal(a.force, true);
  assert.equal(a.tun, true);
  assert.equal(a.help, true);
});

test('shq / isPort / humanAge', () => {
  assert.equal(shq("a'b"), `'a'\\''b'`);
  assert.equal(isPort('65535'), true);
  assert.equal(isPort('0'), false);
  assert.equal(isPort('x'), false);
  assert.equal(humanAge(90061), '1天1小时');
});
