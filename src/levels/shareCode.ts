/**
 * 分享码：把一张地图（或一组随机参数）压成一串可复制、可粘贴的文本。
 *
 * 对外统一使用**可读化**格式（人类不用记，但一眼能看出是"一张迷宫图"）：
 *   地图  RFM1~<宽 36 进制>~<高 36 进制>~<游程编码>~<校验码>~<标题 base64url>
 *   随机  RFR1~<种子>~<列数>~<行数>~<节点数>~<编织比例×100>
 *
 * ⚠️ 这里**没有加密**，也刻意不做"假加密"。原因见文件底部
 *    `toFriendlyCode()` 的注释：客户端加密必然要把密钥一起发出去，
 *    在"零服务器、代码全开源"的前提下只会增加体积、挡住源码可读性，
 *    换不到任何真实的机密性。所以目标是**可读 / 好看**，而不是**看不懂**。
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
 * 可读化外形的前缀，与内部前缀**同长（4 字符）**，便于整体替换。
 *
 * ⚠️ 必须是**两个不同**的前缀，不能统一成 `RESO`：
 * 前缀是解码侧唯一的类型判别依据。曾经为了"看起来更整齐"把两种码
 * 都改成 `RESO·…`，结果随机码全被当成地图码解析
 * （`c29hw` 被读成宽度，报"尺寸 20261012×10 超出范围"）。
 * 统一的品牌感换来的是**类型信息丢失**，得不偿失。
 */
const FRIENDLY_MAP_PREFIX = 'RESO';
const FRIENDLY_RANDOM_PREFIX = 'RESE';
/** 可读化外形里替换 `~` 的可见分隔符（全角中点） */
const FRIENDLY_SEP = '·';
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

/**
 * 把内部格式（`RFM1~a~b~…`）改写成对人更友好的外形。
 *
 * 为什么用 `·`（U+00B7 中点）而不是 `-`：
 * 正文的 MIME type 是 `text/plain`，**没有任何协议层会吞掉空行**，
 * 换行可以放心用；而 `·` 在小字号下比 `~` 温顺得多，读起来像"一串编号"，
 * 不像命令行里粘出来的脏字符。它也不在 base64url 字母表里，不参与数据编码。
 *
 * 抽成独立函数是因为**产出点有四处**（编辑器导出、随机种子码复制、
 * 保存后弹窗、列表分享码 / 通关面板分享码），
 * 漏掉任何一处都会出现"有的码好看有的码难看"。
 */
function toFriendlyCode(internal: string, mapKind: boolean): string {
  const prefix = mapKind ? FRIENDLY_MAP_PREFIX : FRIENDLY_RANDOM_PREFIX;
  return prefix + internal.slice(MAP_PREFIX.length).replace(new RegExp(SEP, 'g'), FRIENDLY_SEP);
}

/**
 * 生成地图分享码（内部格式；对外展示前经 `toFriendlyCode` 换外形）
 * @param title 标题；为空时不写标题字段
 */
export function encodeMapCode(title: string, rows: string[]): string {
  if (rows.length === 0) throw new Error('地图为空，无法生成分享码。');
  const width = rows[0].length;
  const height = rows.length;
  /**
   * 宽度为 0 必须在这里就拒绝，不能放它"编码成功"。
   *
   * 真事：`['']`（一行空字符串）曾能一路走到编码完成，产出一条
   * `RESO·0·1··<校验>·<标题>` 的码 —— 尺寸段是 0、游程段是空，
   * 弹窗里几乎是**一片空白**，看起来就是"分享码没生成出来"。
   * 更糟的是这条码**自己被解码器拒绝**（"尺寸 0×1 超出允许范围"），
   * 即生成了一条不可能被任何人使用的死码。
   *
   * 判据与 `analyzeRows()` 保持一致（它同样以"首行长度为 0"作为硬错误），
   * 这样"能不能编码"和"能不能游玩"不会出现两套标准。
   */
  if (width === 0) throw new Error('地图为空，无法生成分享码。');
  // 行宽不一致的地图同样编不出可解码的码（解码会按 width×height 还原成错行），
  // 这里一并拦下，避免产出"解出来和原图不一样"的码。
  for (let y = 1; y < height; y += 1) {
    if (rows[y].length !== width) throw new Error('地图行列宽度不一致，无法生成分享码。');
  }
  const rle = rleEncode(rows);
  const encodedTitle = title.trim()
    ? toBase64Url(new TextEncoder().encode(title.trim().slice(0, 24)))
    : '';
  // 校验范围覆盖尺寸 + 地图内容 + 标题：任何一段被改动都会被解码时拒绝
  const ck = checksum(`${rle}~${width}~${height}~${encodedTitle}`);
  return [MAP_PREFIX, toBase36(width), toBase36(height), rle, ck, encodedTitle].join(SEP);
}

/**
 * 生成地图分享码的**可读化外形**：这个才是给用户看、给用户发的那串。
 *
 * 与 `encodeMapCode` 的唯一差别是外形（前缀 + 分隔符），
 * 解码侧两条都认，所以新旧码互不影响。
 */
export function encodeMapShareText(title: string, rows: string[]): string {
  return toFriendlyCode(encodeMapCode(title, rows), true);
}

/** 生成随机参数分享码（同一种子 + 参数必定生成同一张地图）；返回可读化外形 */
export function encodeRandomCode(params: RandomLevelParams): string {
  const p = clampParams(params);
  const internal = [
    RANDOM_PREFIX,
    toBase36(p.seed),
    toBase36(p.cols),
    toBase36(p.rows),
    toBase36(p.nodes),
    toBase36(Math.round(p.braid * 100))
  ].join(SEP);
  return toFriendlyCode(internal, false);
}

/**
 * 把用户粘贴的任意外形统一成内部格式。
 *
 * 这一步是"美化外形"能成立的前提：只要在这里收口，
 * 解码逻辑（含校验和、尺寸检查、RLE 校验）一行都不用动，
 * 也就不会因为换外形而引入新的解析漏洞。
 *
 * ⚠️ **只规范前缀，其余字段一律原样保留**。
 * 这里踩过一次坑：曾顺手对整串（或"除标题外全部"）做 `toUpperCase()`，
 * 结果两处同时坏掉 ——
 *   ① 标题段是 base64url，大小写是有效载荷，大写后校验和必然对不上；
 *   ② RLE 段是 `<36 进制计数><地图字符>` 交替，计数用小写字母，
 *      大写后 `rleDecode` 的 `[0-9a-z]` 扫描会在字母处停下，整段错位。
 * 症状都是"明明原样复制的码却报『分享码校验失败』"。
 * 真正需要容错的只有**前缀的大小写**（头是固定字面量），
 * 而且编码侧本来就输出全小写，所以放宽前缀不会削弱任何校验强度。
 */
function normalizeShareText(raw: string): string {
  // 只把中点换成内部分隔符，**不能顺手认半角点**：
  // `.` 正是地图字符（地面），全局替换会把地图内容一起改掉 ——
  // 实测表现为"原样复制的码报『分享码校验失败』"，因为 RLE 段被改写了。
  // 分隔符容错的空间到此为止，宁可让手打的码报格式错误，也不能冒改坏地图的风险。
  const unified = raw.trim().replace(new RegExp(FRIENDLY_SEP, 'g'), SEP).replace(/\s+/g, '');
  if (!unified) return '';

  const parts = unified.split(SEP);
  const head = parts[0].toUpperCase();
  if (head === FRIENDLY_MAP_PREFIX) parts[0] = MAP_PREFIX;
  else if (head === FRIENDLY_RANDOM_PREFIX) parts[0] = RANDOM_PREFIX;
  else parts[0] = head; // 认不出就原样留着，交给下游报"格式错误"
  return parts.join(SEP);
}

/**
 * 解析分享码。新旧两种外形都接受。
 * 任何格式错误都抛出带中文原因的 Error，调用方直接把文案提示给用户即可。
 */
export function decodeShareCode(raw: string): SharePayload {
  const code = normalizeShareText(raw);
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

  throw new Error('无法识别的分享码格式（应以 RESO· 或 RESE· 开头）。');
}

/** 判断一段文本是否像分享码（用于给出更友好的提示）；两种外形都认 */
export function looksLikeShareCode(text: string): boolean {
  const head = normalizeShareText(text).slice(0, 4);
  return head === MAP_PREFIX || head === RANDOM_PREFIX;
}
