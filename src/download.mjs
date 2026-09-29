// vpn-skill :: src/download.mjs
// 下载策略：GitHub 直连 → 国内镜像 → （可选）借海外服务器中转再 SFTP 拉回。
// 最后一条是「本机在墙内、GitHub 不可达」场景的兜底，也是本工具在弱网下最可靠的一条路。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, info, warn, which, run } from './util.mjs';

export const MIRROR_PREFIXES = [
  '', // 直连
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://hub.gitmirror.com/',
  'https://gh.llkk.cc/',
];

export function mirrorUrls(url) {
  const extra = (process.env.VPN_MIRRORS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const prefixes = [...extra, ...MIRROR_PREFIXES];
  return [...new Set(prefixes.map((p) => (p ? p + url : url)))];
}

export async function httpDownload(url, dest, { timeoutMs = 180000, quiet = false } = {}) {
  ensureDir(path.dirname(dest));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    const chunks = [];
    let got = 0;
    let lastTick = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      got += chunk.length;
      if (!quiet && total && Date.now() - lastTick > 1500) {
        lastTick = Date.now();
        process.stderr.write(`\r  ${Math.round((got / total) * 100)}%  ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`);
      }
    }
    if (!quiet && total) process.stderr.write('\r');
    const buf = Buffer.concat(chunks);
    if (buf.length < 1024) throw new Error(`响应体过小（${buf.length}B），可能是镜像错误页`);
    fs.writeFileSync(dest, buf);
    return { path: dest, bytes: buf.length, from: url };
  } finally {
    clearTimeout(timer);
  }
}

/** 依次尝试直连与镜像；全失败返回 null（由调用方决定是否走服务器中转） */
export async function downloadWithMirrors(url, dest, opts = {}) {
  const urls = mirrorUrls(url);
  let lastErr = null;
  for (const u of urls) {
    try {
      info(`下载 ${u.length > 90 ? u.slice(0, 90) + '…' : u}`);
      const r = await httpDownload(u, dest, opts);
      return r;
    } catch (e) {
      lastErr = e;
      warn(`  失败: ${e.message}`);
    }
  }
  warn(`所有源均失败（最后一个错误: ${lastErr?.message}）`);
  return null;
}

// ---------------------------------------------------------------------------
// 版本与资产命名
// ---------------------------------------------------------------------------
export function pinned(name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.sync?.pinned?.[name] || null;
  } catch {
    return null;
  }
}

/** 用已登录的 gh CLI 查最新 tag（避免 api.github.com 匿名限流），失败返回 null */
export function latestTagViaGh(repo) {
  if (!which('gh')) return null;
  const r = run('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name']);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

export async function resolveTag(repo, fallback) {
  const via = latestTagViaGh(repo);
  if (via) return via;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const j = await res.json();
      if (j.tag_name) return j.tag_name;
    }
  } catch { /* 离线/限流都退回固定版本 */ }
  return fallback;
}

export function nodeArchToMihomo(arch = process.arch) {
  return { x64: 'amd64', arm64: 'arm64', ia32: '386' }[arch] || arch;
}

/** 返回 {name, kind}；kind ∈ zip|gz */
export function mihomoAsset(platform = process.platform, arch = process.arch, tag = 'v1.19.31') {
  const a = nodeArchToMihomo(arch);
  if (platform === 'win32') return { name: `mihomo-windows-${a}-${tag}.zip`, kind: 'zip' };
  if (platform === 'darwin') return { name: `mihomo-darwin-${a}-${tag}.gz`, kind: 'gz' };
  return { name: `mihomo-linux-${a}-${tag}.gz`, kind: 'gz' };
}

export function mihomoUrl(tag, assetName) {
  return `https://github.com/MetaCubeX/mihomo/releases/download/${tag}/${assetName}`;
}
