/**
 * 分享码：把一张地图（或一组随机参数）压成一串可复制、可粘贴的文本。
 *
 * 格式（字段以 ~ 分隔，避免和 base64url 的 - _ 冲突）：
 *   地图  RFM1~<宽 36 进制>~<高 36 进制>~<游程编码>~<校验码>~<标题 base64url>
 *   随机  RFR1~<种子>~<列数>~<行数>~<节点数>~<编织比例×100>
 *
 * 设计要点：
 * - 游程编码对迷宫这种大片连续的墙非常有效，29×19 的地图通常只要一两百字符；
 * - 计数用小写 36 进制，地图字符（# . S R E）用大写/符号，两者不会混淆；
 * - 带校验码，粘贴时缺字符或串行会被直接拒绝，而不是生成一张错图；
 * - 解码后一律经 clampParams 夹紧参数范围，防止恶意分享码撑爆内存。
 */

import { RandomLevelParams, clampParams } from '../gen/randomParams';
import { MAP_LIMITS } from './mapAnalysis';

const MAP_PREFIX = 'RFM1';
const RANDOM_PREFIX = 'RFR1';
const SEP = '~';
/**
 * 地图字符白名单。^ 尖刺与 * 回声干扰器必须在这里登记，
 * 否则带陷阱的自定义关卡会在解码时被判为非法字符。
 * 两者都不与字段分隔符 ~ 和小写 36 进制计数冲突。
 */
const TILE_CHARS = '#.SRE^*';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map<string, number>();
for (let i = 0; i < B64.length; i += 1) B64_INDEX.set(B64[i], i);

export type SharePayload =
  | { kind: 'map'; title: string; rows: string[] }
  | { kind: 'random'; params: RandomLevelParams };

// ==================== 基础编码工具 ====================

function toBase36(n: number): string {
  return Math.max(0, Math.floor(n)).toString(36);
}

function fromBase36(text: string): number {
  if (!/^[0-9a-z]+$/.test(text)) return Number.NaN;
  const value = parseInt(text, 36);
  return Number.isFinite(value) ? value : Number.NaN;
}

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64[b2 & 63];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array | null {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    const c: number[] = [];
    for (const ch of chunk) {
      const v = B64_INDEX.get(ch);
      if (v === undefined) return null;
      c.push(v);
    }
    bytes.push((c[0] << 2) | (c[1] >> 4));
    if (c.length > 2) bytes.push(((c[1] & 15) << 4) | (c[2] >> 2));
    if (c.length > 3) bytes.push(((c[2] & 3) << 6) | c[3]);
  }
  return new Uint8Array(bytes);
}

/** FNV-1a 校验码，取 36 进制两位 */
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 1296).toString(36).padStart(2, '0');
}

// ==================== 地图游程编码 ====================

function rleEncode(rows: string[]): string {
  const flat = rows.join('');
  let out = '';
  let i = 0;
  while (i < flat.length) {
    const ch = flat[i];
    let run = 1;
    while (i + run < flat.length && flat[i + run] === ch && run < 1295) run += 1;
    out += `${toBase36(run)}${ch}`;
    i += run;
  }
  return out;
}

/** 解码游程字符串；长度不符或格式非法返回 null */
function rleDecode(rle: string, expectedLength: number): string | null {
  let out = '';
  let i = 0;
  while (i < rle.length) {
    let j = i;
    while (j < rle.length && rle[j] >= '0' && rle[j] <= 'z' && /[0-9a-z]/.test(rle[j])) j += 1;
    if (j >= rle.length) return null;
    if (TILE_CHARS.indexOf(rle[j]) === -1) return null;
    const count = fromBase36(rle.slice(i, j));
    if (!Number.isFinite(count) || count <= 0) return null;
    if (out.length + count > expectedLength) return null;
    out += rle[j].repeat(count);
    i = j + 1;
  }
  return out.length === expectedLength ? out : null;
}

// ==================== 对外 API ====================

/** 生成地图分享码；title 为空时不写标题字段 */
export function encodeMapCode(title: string, rows: string[]): string {
  if (rows.length === 0) throw new Error('地图为空，无法生成分享码。');
  const width = rows[0].length;
  const height = rows.length;
  const rle = rleEncode(rows);
  const encodedTitle = title.trim()
    ? toBase64Url(new TextEncoder().encode(title.trim().slice(0, 24)))
    : '';
  // 校验范围覆盖尺寸 + 地图内容 + 标题：任何一段被改动都会被解码时拒绝
  const ck = checksum(`${rle}~${width}~${height}~${encodedTitle}`);
  return [MAP_PREFIX, toBase36(width), toBase36(height), rle, ck, encodedTitle].join(SEP);
}

/** 生成随机参数分享码（同一种子 + 参数必定生成同一张地图） */
export function encodeRandomCode(params: RandomLevelParams): string {
  const p = clampParams(params);
  return [
    RANDOM_PREFIX,
    toBase36(p.seed),
    toBase36(p.cols),
    toBase36(p.rows),
    toBase36(p.nodes),
    toBase36(Math.round(p.braid * 100))
  ].join(SEP);
}

/**
 * 解析分享码。
 * 任何格式错误都抛出带中文原因的 Error，调用方直接把文案提示给用户即可。
 */
export function decodeShareCode(raw: string): SharePayload {
  const code = raw.replace(/\s+/g, '').trim();
  if (code.length === 0) throw new Error('分享码为空。');

  const parts = code.split(SEP);
  const prefix = parts[0].toUpperCase();

  if (prefix === MAP_PREFIX) {
    if (parts.length < 5) throw new Error('分享码字段不完整，可能复制时缺了一段。');
    const width = fromBase36(parts[1].toLowerCase());
    const height = fromBase36(parts[2].toLowerCase());
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('分享码的尺寸字段无法解析。');
    }
    if (
      width < MAP_LIMITS.minWidth ||
      width > MAP_LIMITS.maxWidth ||
      height < MAP_LIMITS.minHeight ||
      height > MAP_LIMITS.maxHeight
    ) {
      throw new Error(
        `分享码尺寸 ${width}×${height} 超出允许范围（${MAP_LIMITS.minWidth}~${MAP_LIMITS.maxWidth} × ${MAP_LIMITS.minHeight}~${MAP_LIMITS.maxHeight}）。`
      );
    }

    const rle = parts[3];
    const expected = parts[4].toLowerCase();
    const encodedTitle = parts[5] ?? '';
    if (expected !== checksum(`${rle}~${width}~${height}~${encodedTitle}`)) {
      throw new Error('分享码校验失败，请检查是否复制完整。');
    }

    const flat = rleDecode(rle, width * height);
    if (flat === null) throw new Error('分享码内容损坏，无法还原地图。');

    const rows: string[] = [];
    for (let y = 0; y < height; y += 1) rows.push(flat.slice(y * width, (y + 1) * width));

    let title = '';
    if (encodedTitle) {
      const bytes = fromBase64Url(encodedTitle);
      if (bytes) {
        try {
          title = new TextDecoder().decode(bytes);
        } catch {
          title = '';
        }
      }
    }
    return { kind: 'map', title, rows };
  }

  if (prefix === RANDOM_PREFIX) {
    if (parts.length < 6) throw new Error('随机分享码字段不完整。');
    const nums = parts.slice(1, 6).map((part) => fromBase36(part.toLowerCase()));
    if (nums.some((n) => !Number.isFinite(n))) throw new Error('随机分享码含有无法解析的数字。');
    return {
      kind: 'random',
      params: clampParams({
        seed: nums[0],
        cols: nums[1],
        rows: nums[2],
        nodes: nums[3],
        braid: nums[4] / 100
      })
    };
  }

  throw new Error('无法识别的分享码格式（应以 RFM1~ 或 RFR1~ 开头）。');
}

/** 判断一段文本是否像分享码（用于给出更友好的提示） */
export function looksLikeShareCode(text: string): boolean {
  const head = text.replace(/\s+/g, '').slice(0, 4).toUpperCase();
  return head === MAP_PREFIX || head === RANDOM_PREFIX;
}
