// vpn-skill :: src/archive.mjs
// 无第三方依赖的 .gz / .zip 解压（避免为了一个 zip 去装 unzip 二进制或 node 包）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir } from './util.mjs';

export function gunzipFile(srcFile, destFile) {
  const buf = zlib.gunzipSync(fs.readFileSync(srcFile));
  ensureDir(path.dirname(destFile));
  fs.writeFileSync(destFile, buf);
  return destFile;
}

function findEocd(buf) {
  const sig = 0x06054b50;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

/**
 * 极简 zip 解包（支持 store/deflate），返回解出的文件名数组。
 * 只实现 zip 常规路径：mihomo 的 release zip 远小于 4GB，不涉及 zip64。
 */
export function unzipFile(srcFile, destDir, opts = {}) {
  const { wanted = null } = opts;
  const buf = fs.readFileSync(srcFile);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('暂不支持 zip64 归档');
  ensureDir(destDir);
  const written = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (wanted && !wanted.some((w) => name === w || name.endsWith(`/${w}`))) continue;

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的 zip 压缩方式: ${method}`);

    const outPath = path.join(destDir, path.basename(name));
    fs.writeFileSync(outPath, content);
    written.push(outPath);
  }
  if (wanted && written.length === 0) throw new Error(`zip 内未找到期望的文件: ${wanted.join(', ')}`);
  return written;
}
