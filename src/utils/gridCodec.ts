// 像素网格的索引压缩编解码器。
//
// 背景（见 docs/规划/双端云保存待办.md 2.5）：`MappedPixel[][]` 直接 JSON 化后
// 300×200 的网格有 3–10MB，既塞不进 localStorage，也不适合走接口。
// 网格里真正重复度极高的信息是"每格长什么样"，而唯一颜色种类通常只有几十种，
// 所以把颜色抽成一张调色板表，每格只存调色板下标：
//
//   [调色板: {色号 key, hex, 是否外部} × K] + [下标: N×M 个 1 或 2 字节]
//
// 300×200、K=64 时体积约 60KB（与规划文档的估算一致）。
//
// 二进制布局（小端）：
//   0  magic        4 字节 ASCII "PBG1"
//   4  version      u8   = 1
//   5  flags        u8   bit0 = 每格用 2 字节下标
//   6  N            u32
//   10 M            u32
//   14 colorCount   u32
//   18 palette      colorCount 个条目，依次为：
//                    keyLen u8 | key(utf8) | hexLen u8 | hex(utf8) | entryFlags u8
//   .. data         N*M 个小端整数下标
//
// 本文件不依赖任何浏览器 / Node API（只用到 TextEncoder/TextDecoder 与 Uint8Array），
// 因此浏览器端与 Cloudflare Worker 端共用同一份实现。

import type { MappedPixel } from './pixelation';

export const GRID_CODEC_MAGIC = 'PBG1';
export const GRID_CODEC_VERSION = 1;

/** 压缩网格的统计结果，便于写进元数据。 */
export interface EncodedGrid {
  bytes: Uint8Array;
  N: number;
  M: number;
  colors: number;
}

export class GridCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridCodecError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeKey(key: string): string {
  return key ?? '';
}

function normalizeHex(hex: string): string {
  if (!hex) return '';
  return hex.startsWith('#') ? hex : `#${hex}`;
}

/**
 * 把二维像素网格编码为紧凑二进制。
 * @throws GridCodecError 当网格为空、行列不一致或颜色种类超过 65535。
 */
export function encodeGrid(pixels: MappedPixel[][]): EncodedGrid {
  if (!Array.isArray(pixels) || pixels.length === 0) {
    throw new GridCodecError('网格为空，无法编码');
  }

  const M = pixels.length;
  const N = pixels[0]?.length ?? 0;
  if (N === 0) {
    throw new GridCodecError('网格列数为 0，无法编码');
  }

  const palette: MappedPixel[] = [];
  const indexByKey = new Map<string, number>();
  const indices = new Uint32Array(N * M);
  let cursor = 0;

  for (let row = 0; row < M; row++) {
    const line = pixels[row];
    if (!line || line.length !== N) {
      throw new GridCodecError(`第 ${row} 行长度不一致：期望 ${N}，实际 ${line?.length ?? 0}`);
    }
    for (let col = 0; col < N; col++) {
      const cell = line[col] ?? { key: '', color: '' };
      const isExternal = cell.isExternal ? 1 : 0;
      const dedupe = `${cell.key}\u0000${cell.color}\u0000${isExternal}`;
      let index = indexByKey.get(dedupe);
      if (index === undefined) {
        if (palette.length > 0xffff) {
          throw new GridCodecError('网格颜色种类超过 65535，无法压缩');
        }
        index = palette.length;
        indexByKey.set(dedupe, index);
        palette.push({ key: normalizeKey(cell.key), color: normalizeHex(cell.color), isExternal: !!cell.isExternal });
      }
      indices[cursor++] = index;
    }
  }

  const bytesPerCell = palette.length > 256 ? 2 : 1;

  // 先算出总长度，避免反复重建缓冲区
  const paletteEntries = palette.map((entry) => {
    const keyBytes = encoder.encode(entry.key);
    const hexBytes = encoder.encode(entry.color);
    if (keyBytes.length > 255) throw new GridCodecError('色号长度超过 255 字节');
    if (hexBytes.length > 255) throw new GridCodecError('hex 长度超过 255 字节');
    return { keyBytes, hexBytes, flags: entry.isExternal ? 1 : 0 };
  });

  let total = 18;
  for (const entry of paletteEntries) {
    total += 1 + entry.keyBytes.length + 1 + entry.hexBytes.length + 1;
  }
  total += indices.length * bytesPerCell;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (let i = 0; i < GRID_CODEC_MAGIC.length; i++) {
    out[offset++] = GRID_CODEC_MAGIC.charCodeAt(i);
  }
  out[offset++] = GRID_CODEC_VERSION;
  out[offset++] = bytesPerCell === 2 ? 0b1 : 0;
  view.setUint32(offset, N, true); offset += 4;
  view.setUint32(offset, M, true); offset += 4;
  view.setUint32(offset, paletteEntries.length, true); offset += 4;

  for (const entry of paletteEntries) {
    out[offset++] = entry.keyBytes.length;
    out.set(entry.keyBytes, offset); offset += entry.keyBytes.length;
    out[offset++] = entry.hexBytes.length;
    out.set(entry.hexBytes, offset); offset += entry.hexBytes.length;
    out[offset++] = entry.flags;
  }

  if (bytesPerCell === 1) {
    for (let i = 0; i < indices.length; i++) {
      out[offset++] = indices[i];
    }
  } else {
    for (let i = 0; i < indices.length; i++) {
      view.setUint16(offset, indices[i], true);
      offset += 2;
    }
  }

  return { bytes: out, N, M, colors: palette.length };
}

/**
 * 只做结构校验并读出头部信息，不构建整张像素表。
 *
 * 服务端保存网格时用它校验数据合法性并记录 N/M/颜色数：会走一遍调色板并核对
 * 数据区长度，因此截断、`magic` 不对、版本不符都能被发现，但不会为了校验而
 * 分配 N×M 个对象。
 */
export function readGridInfo(bytes: Uint8Array): { N: number; M: number; colors: number; bytes: number } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 18) {
    throw new GridCodecError('网格数据长度不足');
  }
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== GRID_CODEC_MAGIC) {
    throw new GridCodecError(`网格数据格式不匹配（magic=${magic}）`);
  }
  if (bytes[4] !== GRID_CODEC_VERSION) {
    throw new GridCodecError(`不支持的网格编码版本：${bytes[4]}`);
  }
  const bytesPerCell = (bytes[5] & 0b1) === 1 ? 2 : 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const N = view.getUint32(6, true);
  const M = view.getUint32(10, true);
  const colors = view.getUint32(14, true);
  if (N === 0 || M === 0) {
    throw new GridCodecError('网格尺寸为 0');
  }
  if (N * M > 40_000_000) {
    throw new GridCodecError('网格尺寸异常，拒绝解析');
  }

  // 走一遍调色板，确认每个条目完整；顺带算出数据区起点
  let offset = 18;
  for (let i = 0; i < colors; i++) {
    if (offset + 1 > bytes.length) throw new GridCodecError('调色板数据被截断');
    const keyLen = bytes[offset++];
    if (offset + keyLen + 1 > bytes.length) throw new GridCodecError('调色板 key 被截断');
    offset += keyLen;
    const hexLen = bytes[offset++];
    if (offset + hexLen + 1 > bytes.length) throw new GridCodecError('调色板 hex 被截断');
    offset += hexLen;
    offset += 1; // entryFlags
  }

  const expected = offset + N * M * bytesPerCell;
  if (expected !== bytes.length) {
    throw new GridCodecError(`网格数据长度不一致（期望 ${expected} 字节，实际 ${bytes.length} 字节）`);
  }

  return { N, M, colors, bytes: bytes.length };
}

/** 解码紧凑二进制，还原为 `MappedPixel[][]`。 */
export function decodeGrid(bytes: Uint8Array): MappedPixel[][] {
  if (!(bytes instanceof Uint8Array) || bytes.length < 18) {
    throw new GridCodecError('网格数据长度不足');
  }

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== GRID_CODEC_MAGIC) {
    throw new GridCodecError(`网格数据格式不匹配（magic=${magic}）`);
  }

  const version = bytes[4];
  if (version !== GRID_CODEC_VERSION) {
    throw new GridCodecError(`不支持的网格编码版本：${version}`);
  }

  const bytesPerCell = (bytes[5] & 0b1) === 1 ? 2 : 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const N = view.getUint32(6, true);
  const M = view.getUint32(10, true);
  const colorCount = view.getUint32(14, true);

  if (N === 0 || M === 0) {
    throw new GridCodecError('网格尺寸为 0');
  }
  if (N * M > 40_000_000) {
    throw new GridCodecError('网格尺寸异常，拒绝解码');
  }

  let offset = 18;
  const palette: MappedPixel[] = [];
  for (let i = 0; i < colorCount; i++) {
    if (offset + 1 > bytes.length) throw new GridCodecError('调色板数据被截断');
    const keyLen = bytes[offset++];
    if (offset + keyLen > bytes.length) throw new GridCodecError('调色板 key 被截断');
    const key = decoder.decode(bytes.subarray(offset, offset + keyLen)); offset += keyLen;
    if (offset + 1 > bytes.length) throw new GridCodecError('调色板数据被截断');
    const hexLen = bytes[offset++];
    if (offset + hexLen > bytes.length) throw new GridCodecError('调色板 hex 被截断');
    const hex = decoder.decode(bytes.subarray(offset, offset + hexLen)); offset += hexLen;
    if (offset + 1 > bytes.length) throw new GridCodecError('调色板 flags 被截断');
    const flags = bytes[offset++];
    palette.push({ key, color: hex, isExternal: (flags & 0b1) === 1 });
  }

  const dataLength = N * M * bytesPerCell;
  if (offset + dataLength > bytes.length) {
    throw new GridCodecError('网格像素数据被截断');
  }

  const result: MappedPixel[][] = Array(M);
  const fallback: MappedPixel = { key: '', color: '#000000', isExternal: true };
  let cursor = offset;

  for (let row = 0; row < M; row++) {
    const line: MappedPixel[] = Array(N);
    for (let col = 0; col < N; col++) {
      const index = bytesPerCell === 1 ? bytes[cursor] : view.getUint16(cursor, true);
      cursor += bytesPerCell;
      const entry = palette[index];
      if (!entry) {
        // 数据损坏时不整体失败，退化为"外部/透明格"，保证已保存的作品还能打开
        line[col] = { ...fallback };
      } else {
        line[col] = {
          key: entry.key,
          color: entry.color,
          ...(entry.isExternal ? { isExternal: true } : {}),
        };
      }
    }
    result[row] = line;
  }

  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  // 分块处理，避免大网格下 String.fromCharCode(...arr) 触发调用栈上限
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(normalized.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 编码为 base64，便于放进 JSON 请求体。 */
export function encodeGridToBase64(pixels: MappedPixel[][]): { data: string; info: EncodedGrid } {
  const encoded = encodeGrid(pixels);
  return { data: bytesToBase64(encoded.bytes), info: encoded };
}

/** 从 base64 解码。 */
export function decodeGridFromBase64(base64: string): MappedPixel[][] {
  return decodeGrid(base64ToBytes(base64));
}

/** 估算网格格子总数，用于前端做体积提示。 */
export function countGridCells(pixels: MappedPixel[][] | null | undefined): number {
  if (!pixels || pixels.length === 0) return 0;
  return pixels.length * (pixels[0]?.length ?? 0);
}
