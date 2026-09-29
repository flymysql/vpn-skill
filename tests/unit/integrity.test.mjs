// vpn-skill :: tests/unit/integrity.test.mjs
// 仓库级"字节不变量"测试。这些坑都不看内容、只看字节，靠人眼 review 抓不到：
//   1. server/*.sh 必须是 LF —— 会被上传到 Linux 执行，CRLF 会导致 "$'\r': command not found"
//   2. src/win/systemproxy.ps1 必须带 UTF-8 BOM —— Windows PowerShell 5.1 会把无 BOM 的
//      UTF-8 当 ANSI 读，含中文注释的脚本会直接语法错误、功能整体不可用
//   3. 文本文件不得含 NUL 字节
//   4. package.json 可解析；SKILL.md frontmatter 完整且 name 与目录名一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CRLF = Buffer.from([13, 10]);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const listShell = () => [
  ...fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.sh')).map((f) => `server/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'vendor', 'upstream')).filter((f) => f.endsWith('.sh')).map((f) => `vendor/upstream/${f}`),
];

test('server/*.sh 与 vendor/*.sh 必须是 LF（无 CRLF）', () => {
  for (const f of listShell()) {
    assert.ok(!read(f).includes(CRLF), `${f} 含 CRLF —— 上传到 Linux 后 bash 会报 $'\\r': command not found`);
  }
});

test('shell 脚本不得带 BOM', () => {
  for (const f of listShell()) {
    assert.ok(!read(f).subarray(0, 3).equals(BOM), `${f} 带 UTF-8 BOM，Linux 下 shebang 会失效`);
  }
});

test('PowerShell 脚本必须带 UTF-8 BOM（PS 5.1 兼容性）', () => {
  const ps1 = fs.readdirSync(path.join(ROOT, 'src', 'win')).filter((f) => f.endsWith('.ps1'));
  assert.ok(ps1.length > 0, 'src/win 下应有 PowerShell 脚本');
  for (const f of ps1) {
    const p = `src/win/${f}`;
    assert.ok(read(p).subarray(0, 3).equals(BOM), `${p} 缺少 UTF-8 BOM —— Windows PowerShell 5.1 会按 ANSI 解析而语法错误`);
  }
});

test('文本文件不含 NUL 字节', () => {
  const files = [
    ...listShell(),
    'README.md', 'SKILL.md', 'NOTICE', 'package.json',
    'src/win/systemproxy.ps1',
    ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`),
    'bin/vpn.mjs',
  ];
  for (const f of files) {
    assert.ok(!read(f).includes(0), `${f} 含 NUL 字节，可能被当成二进制处理`);
  }
});

test('package.json 合法且关键字段齐全', () => {
  const pkg = JSON.parse(read('package.json').toString('utf8'));
  assert.equal(pkg.name, 'vpn-skill');
  assert.ok(pkg.bin && pkg.bin['vpn-skill'], '必须暴露 vpn-skill 命令');
  assert.ok(pkg.dependencies.ssh2, '必须依赖 ssh2');
  assert.ok(pkg.engines?.node, '必须声明 engines.node');
  assert.ok(pkg.sync?.pinned?.mihomo, '必须钉住 mihomo 版本基线，避免静默漂移');
  assert.equal(pkg.license, 'Apache-2.0');
});

test('SKILL.md frontmatter 完整且与目录名一致', () => {
  const txt = read('SKILL.md').toString('utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md 缺少 YAML frontmatter');
  for (const key of ['name', 'description', 'whenToUse']) {
    assert.ok(new RegExp(`^${key}:`, 'm').test(m[1]), `frontmatter 缺少 ${key}`);
  }
  const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
  assert.equal(name, 'vpn-skill');
});

test('上游快照完整保留（许可合规 + 可溯源）', () => {
  const up = path.join(ROOT, 'vendor', 'upstream');
  for (const f of ['hy2.sh', 'ss-rust.sh', 'reality.sh', 'ws.sh', 'tcp-wss.sh', 'https.sh', 'nft_forward.sh', 'tcp-window.sh', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(up, f)), `vendor/upstream 缺少 ${f}`);
  }
  assert.ok(/Apache License/.test(fs.readFileSync(path.join(up, 'LICENSE'), 'utf8')), '上游许可文件应为 Apache-2.0');
  assert.ok(/chugzb\/VPN/.test(fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8')), 'NOTICE 必须署名上游');
});

test('.gitignore 必须挡住可能含凭据的运行时文件', () => {
  const gi = read('.gitignore').toString('utf8');
  for (const pat of ['state.env', 'meta.json', 'node_modules']) {
    assert.ok(gi.includes(pat), `.gitignore 未忽略 ${pat}`);
  }
});
