/**
 * 拼豆图纸（蓝图）解析算法
 *
 * 用户在弹窗里框选两块区域：
 *   1) 图片区域：图纸上部的格子图案（通常带有黑色外框）
 *   2) 色号清单区域：图纸下部的色号清单（每个色号一个实心色块 + 文字）
 *
 * 解析流程：
 *   - 在图片区域内定位格子外框（最外层「整行/整列都偏暗」的位置）
 *   - 用「格线信号」（每列/行里亮度落差超阈值的像素占比）找出所有格线，
 *     再用相邻格线间距的中位数定出格子边长，从而得到格子数量
 *     （占比信号对深色格线/浅色格线、抗锯齿、JPEG 软化都稳健，
 *      且能天然排除只占部分行的色号文字笔画）
 *   - 逐格取「各通道中位数」作为格子底色（中位数对 JPEG 抖动/抗锯齿比众数稳健得多），
 *     并统计格内深色墨迹占比（用来区分「白色珠子」和「图纸背景」）
 *   - 把格子底色吸附到色号表里最接近的标准色，保证每格都能查到色号
 *   - 读格子里**印着的色号文字**：外来图纸经 JPEG/缩放后色差可能很大
 *     （例如实际是 B15 的深绿被量成 (16,102,26)，最近邻会匹配到 B12），
 *     所以先用颜色圈定一份候选色号，再用文字模板匹配从候选里选出最终色号
 *   - 在色号清单区域用连通域找实心色块，按 行→列 读出候选颜色（用于提示与调色板预选）
 *   - 数量一律由网格统计得出，色号清单区只提供候选色，因此两者天然一致
 *
 * 关键约束：预览与色号清单的数量必须一致，因此两者都来自同一份 mappedPixelData。
 */
import { getColorKeyByHex, getAllHexValues } from './colorSystemUtils';
import type { ColorSystem, MappedPixel, PaletteColor } from './pixelation';

export interface PixelRect {
  /** 原图像素坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlueprintParseResult {
  mappedPixelData: MappedPixel[][];
  gridDimensions: { N: number; M: number };
  colorCounts: Record<string, { count: number; color: string }>;
  totalBeadCount: number;
  /** 色号清单区域解析出的候选颜色（小写 #rrggbb，按图纸上的顺序） */
  paletteHexes: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 外框判定：灰度低于该值算「暗」 */
const FRAME_LUMA = 140;
/** 外框判定：一行/一列里暗像素占比超过该值才算外框线 */
const FRAME_FRACTION = 0.6;
/** 一个格子至少需要这么多像素宽，否则不认为它是格子 */
const MIN_CELL_PX = 3;
/** 单边最大格子数 */
const MAX_CELL_COUNT = 300;
/** 格线信号：像素与左右（上下）邻居的亮度落差超过该值算「命中」 */
const LINE_CONTRAST = 18;
/** 格线信号：一整条带里命中的行（列）占比达到该值才算格线 */
const LINE_PEAK_RATIO = 0.7;
/** 同一条格线可能占 2 个像素列，相距不超过该值的峰合并为一个 */
const LINE_MERGE_PX = 6;
/** 文字墨迹：灰度低于该值算「深色墨迹」 */
const INK_LUMA = 80;
/** 判定「格子里有文字」的墨迹占比阈值 */
const INK_FRACTION = 0.02;
/** 判定「接近白色」的通道阈值 */
const NEAR_WHITE = 240;
/** 色块统一度下限（「与众数色接近」的像素占比） */
const SWATCH_UNIFORMITY = 0.85;
/** 统计色块统一度时，「与众数色接近」的距离阈值（容忍 JPEG 噪点） */
const SWATCH_TOLERANCE = 32;
/** 色块最小边长 */
const SWATCH_MIN_SIZE = 12;
/** 接近纯白的判定：所有通道都不低于该值时，一律按白色珠子处理 */
const ABSOLUTE_WHITE = 248;
/** 白色珠子（MARD H02）——本站导出图纸里白色珠子用的就是这个色 */
const WHITE_BEAD_RGB: [number, number, number] = [254, 255, 255];

/* ---- 格内色号文字识别 ---- */

/** 文字笔画：像素亮度与格子底色亮度差超过该值就算「不是底色」 */
const TEXT_CONTRAST = 45;
/** 取文字掩码时去掉的边框环宽（相对格子短边的比例），用来去掉格线与抗锯齿 */
const TEXT_RING_RATIO = 0.11;
/** 边框环的最小宽度（像素） */
const TEXT_RING_MIN = 3;
/** 判定「格子里印了色号」：笔画像素占掩码面积的下限 */
const TEXT_MIN_FRACTION = 0.02;
/** 判定「格子里印了色号」：笔画像素占掩码面积的上限（超过说明不是文字） */
const TEXT_MAX_FRACTION = 0.6;
/**
 * 文字包围盒高度最多占整个掩码的比例。
 *
 * 只用高度做判据，不能用宽度：色号是三字符（如 D02）时字宽实测 23~24px，
 * 和 30px 格子内缩后的掩码一样宽，按宽度卡会把绝大多数正常文字整格挡掉
 * （实测 1709 个格子里有 1454 个因此被丢弃）。而「整格都是笔画」的结构型掩码
 * （坐标尺、色带等）必然是满高的，高度判据配合 TEXT_MIN_DENSITY 足够把它们挡住。
 */
const TEXT_MAX_BBOX_RATIO = 0.95;
/**
 * 笔画在包围盒里的密度下限。真字的笔画密实（实测 0.44~0.51），
 * 而空格的噪点／水印是稀疏散布（实测 0.06~0.12），用它把噪点挡在文字格之外。
 */
const TEXT_MIN_DENSITY = 0.25;
/** 文字光栅的列数（按高度归一化、水平居中，保留整串字的宽度＝字数信息） */
const TEXT_RASTER_W = 24;
/** 文字光栅的行数 */
const TEXT_RASTER_H = 12;
/**
 * 聚类：底色距离不超过该值的格子视为同一种珠子。
 * 同一种珠子印的色号必然相同，所以底色是比字形可靠得多的聚类依据——按字形聚类
 * 会把中绿(B08)与浅绿(B20)这种字形相近的格子并到一起，再用簇内中位分把它们统一判错。
 */
const TEXT_FILL_MERGE = 18;
/** 每簇最多取多少个格子参与打分（取簇内均匀抽样，用中位分抵抗 JPEG 噪点） */
const TEXT_SAMPLE_LIMIT = 8;
/**
 * 少于这么多格的簇不采信文字。单格成簇时没有任何旁证，一张被 JPEG 糊掉/粘连的掩码
 * 很容易在字形上蒙对一个错误的色号（实测：某红格印的是 F4，却被读成 F03），
 * 而「颜色最近的色号」在这种孤立格上反而更稳。
 */
const TEXT_MIN_CLUSTER = 2;
/**
 * 颜色合理性闸门：印字读出的色号，其标准色离格子实测底色不能太远。
 * 字形度量只有 24×12 的二值光栅，相位抖动足以让「D02」这种正确的候选输给
 * 「D24」（自家图纸实测 0.240 vs 0.212），所以文字不能无条件覆盖颜色结论；
 * 但真正需要文字的场合（外来图纸色差）gap 很小：实测 B15 3.3、B25 3.1，
 * 而误读的 gap 是 D24 18.0、D17 17.1、C07 138.4，用 8 就能干净分开。
 */
const TEXT_COLOR_SLACK = 8;
/** 闸门的相对宽松度：底色本身就偏得远时（图纸色差大），按比例一起放宽 */
const TEXT_COLOR_RELATIVE = 1.6;
/**
 * 文字覆盖颜色所需的最小得分优势（绝对分差，分数越小越好）。
 * 24×12 二值光栅的噪声量级就是几个千分点：自家图纸上「H2」被读成「H1」时两者只差
 * 0.004，而真正需要文字纠正的场合分差大得多（外来图纸 B15 0.150 vs B12 0.195 = 0.045）。
 * 字形打平就说明是噪声主导，此时应当相信颜色——否则 H02 会被改写成近白的 H01。
 */
const TEXT_SCORE_MARGIN = 0.015;
/** 模板二值化阈值：模板是白底黑字，取 0.2 覆盖率（255 × 0.8）与测量掩码的灵敏度一致 */
const TEMPLATE_INK_LEVEL = 204;
/** 接受文字结果的分差上限（光栅平均差 + 3 × 孔洞差） */
const TEXT_ACCEPT = 0.3;
/** 扫描字号时围绕基准字号上下各试几个像素 */
const TEXT_SIZE_SPAN = 3;
/** 文字模板的字体候选（图纸作者机器上的字体未知，等宽与无衬线都试一遍） */
const TEXT_FONT_FAMILIES = ['sans-serif', 'monospace'];
/** 颜色短名单最多取多少个色号 */
const TEXT_SHORTLIST_LIMIT = 8;
/** 颜色短名单加上图纸清单色号后的总上限 */
const TEXT_SHORTLIST_TOTAL = 12;
/** 超过这么多格子就跳过文字识别（避免超大图纸把内存和耗时拉爆） */
const TEXT_CELL_LIMIT = 30000;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function unpackRgb(value: number): [number, number, number] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function hexToRgbTuple(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbDistance(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** 色号表里的全部标准色（懒加载一次） */
let canonicalPaletteCache: Array<{ hex: string; rgb: [number, number, number] }> | null = null;
function canonicalPalette(): Array<{ hex: string; rgb: [number, number, number] }> {
  if (!canonicalPaletteCache) {
    canonicalPaletteCache = getAllHexValues()
      .map(hex => {
        const tuple = hexToRgbTuple(hex);
        return tuple ? { hex: hex.toLowerCase(), rgb: tuple } : null;
      })
      .filter((entry): entry is { hex: string; rgb: [number, number, number] } => entry !== null);
  }
  return canonicalPaletteCache;
}

/**
 * 把量到的近似色吸附到色号表里最接近的标准色（**总是**吸附）。
 *
 * 图纸经过 JPEG 压缩、缩放或抗锯齿时，量到的颜色会偏离标准色几个数值，
 * 不吸附的话 getColorKeyByHex 查不到色号（返回 '?'）。
 * 图纸的每一格本身必然是某个色号色，所以即使量到的颜色离标准色较远
 * （非本站导出的图纸常见），按最近标准色处理也比保留一个查不到色号的
 * 颜色更合理。
 */
function canonicalizeRgb(rgb: [number, number, number]): [number, number, number] {
  // 色号表里有一族几乎完全一样的「白」（#FDFBFF / #FEFFFF / #FFFDF0 / #FCF7F8 / #FFFFFF），
  // 相互距离比测量误差还小，靠最近邻会在它们之间随机跳动。
  // 任意接近纯白的颜色一律按白色珠子（MARD H02）处理，保证结果稳定。
  if (rgb[0] >= ABSOLUTE_WHITE && rgb[1] >= ABSOLUTE_WHITE && rgb[2] >= ABSOLUTE_WHITE) {
    return [...WHITE_BEAD_RGB];
  }
  const palette = canonicalPalette();
  let bestDistance = Infinity;
  let result = rgb;
  for (let i = 0; i < palette.length; i++) {
    const distance = rgbDistance(rgb, palette[i].rgb);
    if (distance < bestDistance) {
      bestDistance = distance;
      result = palette[i].rgb;
    }
  }
  return result;
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法读取图片内容'));
    img.src = src;
  });
}

/** 把原图整幅画到 canvas 上，得到一次 getImageData（后续所有解析都在这份像素上做） */
export async function readImagePixels(imageSrc: string): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  const img = await loadImageElement(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 canvas 2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

/**
 * 抠出一块矩形区域的灰度矩阵 + 颜色矩阵，坐标相对该矩形左上角。
 */
function extractRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rect: PixelRect,
): { gray: Float32Array; rgb: Uint8ClampedArray; w: number; h: number } | null {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(Math.round(rect.width), width - x);
  const h = Math.min(Math.round(rect.height), height - y);
  if (w < 4 || h < 4) return null;
  const gray = new Float32Array(w * h);
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let j = 0; j < h; j++) {
    const srcRow = (y + j) * width;
    for (let i = 0; i < w; i++) {
      const si = (srcRow + x + i) * 4;
      const r = data[si];
      const g = data[si + 1];
      const b = data[si + 2];
      const di = j * w + i;
      gray[di] = luma(r, g, b);
      rgb[di * 3] = r;
      rgb[di * 3 + 1] = g;
      rgb[di * 3 + 2] = b;
    }
  }
  return { gray, rgb, w, h };
}

/* ------------------------------------------------------------------ *
 * 1. 定位格子外框
 * ------------------------------------------------------------------ */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 找出区域内最外层的「几乎整行/整列都暗」的位置，作为格子外框。
 * 用固定阈值 + 占比判定，对细的黑框（含抗锯齿）都稳定。
 */
function detectFrame(region: { gray: Float32Array; w: number; h: number }): Box | null {
  const { gray, w, h } = region;
  let top = -1;
  let bottom = -1;
  let left = -1;
  let right = -1;

  for (let y = 0; y < h; y++) {
    let dark = 0;
    for (let x = 0; x < w; x++) if (gray[y * w + x] < FRAME_LUMA) dark++;
    if (dark / w >= FRAME_FRACTION) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  for (let x = 0; x < w; x++) {
    let dark = 0;
    for (let y = 0; y < h; y++) if (gray[y * w + x] < FRAME_LUMA) dark++;
    if (dark / h >= FRAME_FRACTION) {
      if (left < 0) left = x;
      right = x;
    }
  }

  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  if (right - left < 8 || bottom - top < 8) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/* ------------------------------------------------------------------ *
 * 2. 估算格子数量
 * ------------------------------------------------------------------ */

/**
 * 「格线信号」：格线是一条贯穿整条带的细线（深色线或浅色线都可以）。
 * 对每一列（axis='x'）统计「该列与左右邻居的亮度落差超过阈值」的行占比，
 * 对每一行（axis='y'）统计列占比。
 *
 * 为什么用「占比」而不是「落差的平均值」：
 *   - 贯穿整幅的格线在任何一行都有落差，占比≈1.0；
 *   - 格子内部的色号文字笔画只覆盖一部分行，占比≈0.5，可被阈值直接排除；
 *   - 深色格线（外部图纸）与浅色格线（本项目导出）都只是「落差为正」，
 *     取绝对值后统一处理，不需要区分颜色。
 *
 * @param axis 'x' 表示沿水平方向找竖直格线（统计列），'y' 表示沿垂直方向找水平格线（统计行）
 */
function lineProfile(
  region: { gray: Float32Array; w: number; h: number },
  box: Box,
  axis: 'x' | 'y',
): Float32Array {
  const { gray, w, h } = region;
  if (axis === 'x') {
    const out = new Float32Array(box.width);
    for (let i = 0; i < box.width; i++) {
      const x = box.x + i;
      if (x - 1 < 0 || x + 1 >= w) continue;
      let hits = 0;
      for (let j = 0; j < box.height; j++) {
        const row = (box.y + j) * w;
        const g = gray[row + x];
        if (Math.abs(g - (gray[row + x - 1] + gray[row + x + 1]) / 2) > LINE_CONTRAST) hits++;
      }
      out[i] = box.height > 0 ? hits / box.height : 0;
    }
    return out;
  }
  const out = new Float32Array(box.height);
  for (let j = 0; j < box.height; j++) {
    const y = box.y + j;
    if (y - 1 < 0 || y + 1 >= h) continue;
    let hits = 0;
    for (let i = 0; i < box.width; i++) {
      const x = box.x + i;
      const g = gray[y * w + x];
      if (Math.abs(g - (gray[(y - 1) * w + x] + gray[(y + 1) * w + x]) / 2) > LINE_CONTRAST) hits++;
    }
    out[j] = box.width > 0 ? hits / box.width : 0;
  }
  return out;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * 由格线信号估计格子数量：
 *   1) 取「占比 ≥ LINE_PEAK_RATIO 的局部极大」作为格线位置，相距很近的合并为一条；
 *   2) 相邻格线间距取中位数（迭代剔除「缺线」造成的超大间距）得到格线周期；
 *   3) 用首尾格线的总跨度把周期精修成 (首尾跨度 / 整数个周期)，消除取整误差；
 *   4) 格子数 = round(整条带跨度 / 周期)。
 */
function detectCellCount(profile: Float32Array): number | null {
  const span = profile.length - 1;
  if (span < 8) return null;

  // 1) 格线位置
  const raw: number[] = [];
  for (let i = 2; i < profile.length - 2; i++) {
    if (profile[i] >= LINE_PEAK_RATIO && profile[i] >= profile[i - 1] && profile[i] >= profile[i + 1]) {
      raw.push(i);
    }
  }
  const centers: number[] = [];
  let clusterSum = 0;
  let clusterCount = 0;
  for (const index of raw) {
    const lastCenter = centers[centers.length - 1];
    if (lastCenter !== undefined && index - lastCenter <= LINE_MERGE_PX) {
      clusterSum += index;
      clusterCount += 1;
      centers[centers.length - 1] = clusterSum / clusterCount;
    } else {
      clusterSum = index;
      clusterCount = 1;
      centers.push(index);
    }
  }
  if (centers.length < 3) return null;

  // 2) 周期
  const diffs: number[] = [];
  for (let i = 1; i < centers.length; i++) {
    const d = centers[i] - centers[i - 1];
    if (d >= MIN_CELL_PX) diffs.push(d);
  }
  if (!diffs.length) return null;
  let period = medianOf(diffs);
  for (let round = 0; round < 3; round++) {
    const kept = diffs.filter(d => d <= period * 1.6);
    if (kept.length < 3) break;
    period = medianOf(kept);
  }
  if (period < MIN_CELL_PX) return null;

  // 3) 精修周期
  const gridSpan = centers[centers.length - 1] - centers[0];
  const lineCount = Math.round(gridSpan / period);
  if (lineCount >= 1) {
    const refined = gridSpan / lineCount;
    if (refined >= MIN_CELL_PX) period = refined;
  }

  // 4) 格子数
  const count = Math.round(span / period);
  if (count < 4 || count > MAX_CELL_COUNT) return null;
  return count;
}

/* ------------------------------------------------------------------ *
 * 3. 解析色号清单区域
 * ------------------------------------------------------------------ */

interface Swatch {
  x: number;
  y: number;
  width: number;
  height: number;
  hex: string;
}

/**
 * 用连通域找「实心色块」：色号清单里的色块是纯色填充 + 细边框，
 * 其内部统一度接近 1.0，而文字笔画统一度很低，据此过滤。
 */
function detectSwatches(
  region: { gray: Float32Array; rgb: Uint8ClampedArray; w: number; h: number },
): Swatch[] {
  const { rgb, w, h } = region;
  const background = dominantColor(region);
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const swatches: Swatch[] = [];

  const isBackground = (index: number): boolean => {
    const r = rgb[index * 3];
    const g = rgb[index * 3 + 1];
    const b = rgb[index * 3 + 2];
    return (
      Math.abs(r - background[0]) <= 12 &&
      Math.abs(g - background[1]) <= 12 &&
      Math.abs(b - background[2]) <= 12
    );
  };

  for (let start = 0; start < w * h; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    if (isBackground(start)) continue;

    stack.length = 0;
    stack.push(start);
    let minX = start % w;
    let maxX = minX;
    let minY = Math.floor(start / w);
    let maxY = minY;

    while (stack.length) {
      const index = stack.pop() as number;
      const x = index % w;
      const y = (index - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const n = index - 1;
        if (!visited[n]) {
          visited[n] = 1;
          if (!isBackground(n)) stack.push(n);
        }
      }
      if (x < w - 1) {
        const n = index + 1;
        if (!visited[n]) {
          visited[n] = 1;
          if (!isBackground(n)) stack.push(n);
        }
      }
      if (y > 0) {
        const n = index - w;
        if (!visited[n]) {
          visited[n] = 1;
          if (!isBackground(n)) stack.push(n);
        }
      }
      if (y < h - 1) {
        const n = index + w;
        if (!visited[n]) {
          visited[n] = 1;
          if (!isBackground(n)) stack.push(n);
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (boxWidth < SWATCH_MIN_SIZE || boxHeight < SWATCH_MIN_SIZE) continue;
    const ratio = boxWidth / boxHeight;
    if (ratio < 0.6 || ratio > 1.7) continue;

    // 内部（避开 1px 边框与抗锯齿）取众数颜色，再用「与众数色接近的占比」衡量统一度
    const inset = 2;
    const counts = new Map<number, number>();
    let total = 0;
    for (let y = minY + inset; y <= maxY - inset; y++) {
      for (let x = minX + inset; x <= maxX - inset; x++) {
        const index = y * w + x;
        const key = packRgb(rgb[index * 3], rgb[index * 3 + 1], rgb[index * 3 + 2]);
        counts.set(key, (counts.get(key) || 0) + 1);
        total++;
      }
    }
    if (!total) continue;
    let modeKey = -1;
    let modeCount = 0;
    counts.forEach((count, key) => {
      if (count > modeCount) {
        modeCount = count;
        modeKey = key;
      }
    });
    // JPEG 压缩会让同一块纯色出现大量轻微不同的数值，所以不能直接看「众数占比」，
    // 而要统计「接近众数色」的像素占比。
    const modeRgb = unpackRgb(modeKey);
    let nearMode = 0;
    for (let y = minY + inset; y <= maxY - inset; y++) {
      for (let x = minX + inset; x <= maxX - inset; x++) {
        const index = y * w + x;
        const pixel: [number, number, number] = [
          rgb[index * 3],
          rgb[index * 3 + 1],
          rgb[index * 3 + 2],
        ];
        if (rgbDistance(pixel, modeRgb) <= SWATCH_TOLERANCE) nearMode++;
      }
    }
    if (nearMode / total < SWATCH_UNIFORMITY) continue;

    const canonical = canonicalizeRgb(modeRgb);
    swatches.push({
      x: minX,
      y: minY,
      width: boxWidth,
      height: boxHeight,
      hex: rgbToHex(canonical[0], canonical[1], canonical[2]),
    });
  }

  return sortSwatchesInReadingOrder(swatches);
}

/** 区域内出现次数最多的颜色（用作背景色） */
function dominantColor(region: { rgb: Uint8ClampedArray; w: number; h: number }): [number, number, number] {
  const { rgb } = region;
  const counts = new Map<number, number>();
  // 抽样即可，背景色一定是压倒性多数
  for (let i = 0; i < region.w * region.h; i += 3) {
    const key = packRgb(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let modeKey = packRgb(255, 255, 255);
  let modeCount = -1;
  counts.forEach((count, key) => {
    if (count > modeCount) {
      modeCount = count;
      modeKey = key;
    }
  });
  return unpackRgb(modeKey);
}

/** 按 行（y 接近的算同一行）→ 列（x 升序）排序，得到图纸上的阅读顺序 */
function sortSwatchesInReadingOrder(swatches: Swatch[]): Swatch[] {
  if (!swatches.length) return swatches;
  const heights = swatches.map(swatch => swatch.height).sort((a, b) => a - b);
  const tolerance = Math.max(4, heights[Math.floor(heights.length / 2)] * 0.6);

  const rows: Array<{ y: number; items: Swatch[] }> = [];
  swatches.forEach(swatch => {
    const center = swatch.y + swatch.height / 2;
    const row = rows.find(entry => Math.abs(entry.y - center) <= tolerance);
    if (row) {
      row.items.push(swatch);
      row.y = (row.y * (row.items.length - 1) + center) / row.items.length;
    } else {
      rows.push({ y: center, items: [swatch] });
    }
  });
  rows.sort((a, b) => a.y - b.y);
  rows.forEach(row => row.items.sort((a, b) => a.x - b.x));
  return rows.flatMap(row => row.items);
}

/* ------------------------------------------------------------------ *
 * 4. 读取图纸上印的色号文字
 * ------------------------------------------------------------------ */

/** 一张文字模板位图（约定白底黑字，尺寸随意） */
export interface TextTemplateBitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 文字模板渲染器。浏览器里默认用 canvas 现渲染；离线测试环境没有 canvas 文字能力，
 * 可以传入由真实字体位图（例如 DejaVuSans-Bold）驱动的实现来跑通整条流程。
 */
export type TextTemplateRenderer = (text: string, fontFamily: string, size: number) => TextTemplateBitmap;

/** 用 canvas 渲染一张「白底黑字」的模板位图 */
/** 复用的模板画布（见 renderTextTemplateWithCanvas） */
let templateCanvas: HTMLCanvasElement | null = null;

function renderTextTemplateWithCanvas(text: string, fontFamily: string, size: number): TextTemplateBitmap {
  const font = `bold ${size}px ${fontFamily}`;
  // 所有模板复用同一张 canvas：一张图纸要渲染上千个模板，每次新建 canvas 再取像素
  // 在浏览器里非常贵（实测会把解析拖到几十秒，最终触发 CDP 超时）
  if (!templateCanvas) templateCanvas = document.createElement('canvas');
  const canvas = templateCanvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas 2d');
  ctx.font = font;
  const textWidth = Math.max(1, Math.ceil(ctx.measureText(text).width));
  const pad = Math.max(2, Math.ceil(size * 0.4));
  canvas.width = textWidth + pad * 2;
  canvas.height = Math.ceil(size * 1.7) + pad * 2;
  // 改画布尺寸会重置上下文状态，字体与填充色都要重新设
  ctx.font = font;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = font;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: image.data, width: canvas.width, height: canvas.height };
}

/** 一段文字（或一个格子的笔画）提取出的形状特征 */
interface GlyphMask {
  /** 掩码像素，1 = 笔画；长度 = w × h */
  bits: Uint8Array;
  w: number;
  h: number;
  /** 笔画像素数 */
  ink: number;
  /** 笔画包围盒（含端点，坐标相对掩码左上角） */
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
  /** 孔洞数（欧拉数里的 H），字母/数字的强区分特征 */
  holes: number;
}

/**
 * 统计包围盒内「不与外界连通的背景连通域」个数，即字的孔洞数。
 * A→1、B/8→2、0/6/9→1、其余多为 0，对 6/8/9 这种同形字很关键。
 */
function countGlyphHoles(
  bits: Uint8Array,
  w: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): number {
  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;
  // 四周补 1 像素，让「外界」一定能通过补边连通
  const width = bw + 2;
  const height = bh + 2;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const isInk = (x: number, y: number): boolean =>
    x >= 1 && y >= 1 && x <= bw && y <= bh && bits[(by0 + y - 1) * w + (bx0 + x - 1)] === 1;

  let holes = 0;
  for (let start = 0; start < width * height; start++) {
    if (seen[start]) continue;
    const sx = start % width;
    const sy = (start - sx) / width;
    if (isInk(sx, sy)) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let touchesBorder = false;
    while (stack.length) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x > 0) {
        const n = index - 1;
        if (!seen[n] && !isInk(x - 1, y)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (x < width - 1) {
        const n = index + 1;
        if (!seen[n] && !isInk(x + 1, y)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = index - width;
        if (!seen[n] && !isInk(x, y - 1)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (y < height - 1) {
        const n = index + width;
        if (!seen[n] && !isInk(x, y + 1)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (!touchesBorder) holes++;
  }
  return holes;
}

/** 由二值掩码算出孔洞数 */
function buildGlyphMask(
  bits: Uint8Array,
  w: number,
  h: number,
  ink: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): GlyphMask {
  return {
    bits,
    w,
    h,
    ink,
    bx0,
    by0,
    bx1,
    by1,
    holes: countGlyphHoles(bits, w, bx0, by0, bx1, by1),
  };
}

/** 从一个格子里抠出「与底色不同」的笔画掩码 */
function extractGlyphMask(
  region: { gray: Float32Array; w: number },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fillLuma: number,
): GlyphMask | null {
  const mw = x1 - x0 + 1;
  const mh = y1 - y0 + 1;
  if (mw < 4 || mh < 4) return null;
  const bits = new Uint8Array(mw * mh);
  let ink = 0;
  let bx0 = mw;
  let by0 = mh;
  let bx1 = -1;
  let by1 = -1;
  for (let y = y0; y <= y1; y++) {
    const rowOffset = y * region.w;
    const localRow = (y - y0) * mw;
    for (let x = x0; x <= x1; x++) {
      if (Math.abs(region.gray[rowOffset + x] - fillLuma) <= TEXT_CONTRAST) continue;
      bits[localRow + (x - x0)] = 1;
      ink++;
      const lx = x - x0;
      const ly = y - y0;
      if (lx < bx0) bx0 = lx;
      if (lx > bx1) bx1 = lx;
      if (ly < by0) by0 = ly;
      if (ly > by1) by1 = ly;
    }
  }
  if (!ink) return null;
  return buildGlyphMask(bits, mw, mh, ink, bx0, by0, bx1, by1);
}

/** 把模板位图二值化成同样的形状特征 */
function maskFromTemplate(bitmap: TextTemplateBitmap): GlyphMask | null {
  const { data, width, height } = bitmap;
  if (!width || !height || data.length < width * height * 4) return null;
  const bits = new Uint8Array(width * height);
  let ink = 0;
  let bx0 = width;
  let by0 = height;
  let bx1 = -1;
  let by1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (luma(data[i], data[i + 1], data[i + 2]) >= TEMPLATE_INK_LEVEL) continue;
      bits[y * width + x] = 1;
      ink++;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (!ink) return null;
  return buildGlyphMask(bits, width, height, ink, bx0, by0, bx1, by1);
}

/**
 * 把一段笔画重采样成固定光栅：**按高度归一化、水平居中**。
 *
 * 为什么不是简单地按包围盒归一化（那样会把整串字的宽度信息抹掉）：
 * 图纸印的色号长度不同——两位数的 B15/B25 是 3 个字符，B08 印成 B8 只有 2 个字符。
 * 「几个字」是最稳的判别特征之一，所以这里只统一高度，宽度按同一比例缩放后居中，
 * 落在光栅之外的笔画自然被裁掉：2 字与 3 字的串在光栅里宽度明显不同。
 */
function buildTextRaster(mask: GlyphMask): Float32Array {
  const spanX = mask.bx1 - mask.bx0 + 1;
  const spanY = mask.by1 - mask.by0 + 1;
  const scale = TEXT_RASTER_H / spanY;
  const offsetX = (TEXT_RASTER_W - spanX * scale) / 2;
  const counts = new Float32Array(TEXT_RASTER_W * TEXT_RASTER_H);
  for (let y = mask.by0; y <= mask.by1; y++) {
    const rowOffset = y * mask.w;
    const oy = Math.min(TEXT_RASTER_H - 1, Math.floor((y - mask.by0) * scale));
    for (let x = mask.bx0; x <= mask.bx1; x++) {
      if (!mask.bits[rowOffset + x]) continue;
      const ox = Math.floor(offsetX + (x - mask.bx0) * scale);
      if (ox < 0 || ox >= TEXT_RASTER_W) continue;
      counts[oy * TEXT_RASTER_W + ox] += 1;
    }
  }
  // 每个输出单元覆盖多少原始像素，用它把计数变成 0..1 的覆盖率
  const expected = Math.max(1, (1 / scale) * (1 / scale));
  const raster = new Float32Array(counts.length);
  for (let i = 0; i < counts.length; i++) raster[i] = Math.min(1, counts[i] / expected);
  return raster;
}

/** 一段文字的形状：光栅 + 孔洞数（光栅只算一次，供短名单里每个候选复用） */
interface TextShape {
  raster: Float32Array;
  holes: number;
}

function textShapeOf(mask: GlyphMask): TextShape {
  return { raster: buildTextRaster(mask), holes: mask.holes };
}

/** 两段文字的分差：光栅平均差 + 3 × 孔洞差 */
function textScore(cell: TextShape, template: TextShape): number {
  let sum = 0;
  for (let i = 0; i < cell.raster.length; i++) {
    sum += Math.abs(cell.raster[i] - template.raster[i]);
  }
  return sum / cell.raster.length + 3 * Math.abs(cell.holes - template.holes);
}

/** 图纸上常把前导零省掉（H07 印成 H7、B08 印成 B8），候选里两种写法都要试 */
function compactCode(code: string): string {
  const match = /^([A-Za-z]+)0*(\d+)$/.exec(code);
  if (!match) return code;
  return `${match[1]}${match[2]}`;
}

/**
 * 一张图纸上同一个色号可能有好几种印法，都要拿来当模板：
 *   - 原样：B20
 *   - 去掉前导零：B08 → B8、H07 → H7
 *   - 作者直接删掉色号里的第一个 '0'（实测的图纸就是这么印的）：B20 → B2、H02 → H2、B08 → B8
 * 注意 B20 与 B02 删零后都是「B2」，字面无法区分，靠颜色短名单里更近的那个胜出。
 */
function printedCodeForms(code: string): string[] {
  const forms = new Set<string>([code]);
  forms.add(compactCode(code));
  const stripped = `${code.slice(0, 1)}${code.slice(1).replace('0', '')}`;
  if (stripped.length >= 2) forms.add(stripped);
  return Array.from(forms).filter(form => form.length > 1);
}

/** 色号 → 标准色的 hex（按色号系统缓存） */
const codeHexCache = new Map<ColorSystem, Map<string, string>>();
function buildCodeHexMap(colorSystem: ColorSystem): Map<string, string> {
  const cached = codeHexCache.get(colorSystem);
  if (cached) return cached;
  const map = new Map<string, string>();
  for (const entry of canonicalPalette()) {
    const code = getColorKeyByHex(entry.hex.toUpperCase(), colorSystem);
    if (!code || code === '?' || map.has(code)) continue;
    map.set(code, entry.hex);
  }
  codeHexCache.set(colorSystem, map);
  return map;
}

interface CodeCandidate {
  code: string;
  hex: string;
  distance: number;
}

/**
 * 颜色短名单：离格子底色最近的那些标准色号（距离 < max(45, 1.35 × 最佳距离)），
 * 再加上图纸自带的色号清单里出现的色号——清单是作者写下的使用范围，是很强的先验。
 * 文字识别只在这个名单里挑，避免把格子读成图纸上根本不存在的色号。
 */
function buildCodeShortlist(
  fillRgb: [number, number, number],
  legendHexes: string[],
  colorSystem: ColorSystem,
): CodeCandidate[] {
  const scored: CodeCandidate[] = [];
  for (const entry of canonicalPalette()) {
    const code = getColorKeyByHex(entry.hex.toUpperCase(), colorSystem);
    if (!code || code === '?') continue;
    scored.push({ code, hex: entry.hex, distance: rgbDistance(fillRgb, entry.rgb) });
  }
  scored.sort((a, b) => a.distance - b.distance);
  const bestDistance = scored.length ? scored[0].distance : 0;
  const limit = Math.max(45, bestDistance * 1.35);
  const picked: CodeCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < scored.length && picked.length < TEXT_SHORTLIST_LIMIT; i++) {
    const entry = scored[i];
    if (entry.distance >= limit) break;
    if (seen.has(entry.code)) continue;
    seen.add(entry.code);
    picked.push(entry);
  }
  for (const hex of legendHexes) {
    if (picked.length >= TEXT_SHORTLIST_TOTAL) break;
    const code = getColorKeyByHex(hex.toUpperCase(), colorSystem);
    if (!code || code === '?' || seen.has(code)) continue;
    const tuple = hexToRgbTuple(hex) ?? fillRgb;
    seen.add(code);
    picked.push({ code, hex, distance: rgbDistance(fillRgb, tuple) });
  }
  return picked;
}

/** 一个「印了色号」的格子 */
interface TextCellSample {
  index: number;
  fill: [number, number, number];
  mask: GlyphMask;
  /** 仅按颜色匹配会得到的色号（文字识别失败时的兜底，也用来提示分歧） */
  colorCode: string;
}

interface TextReadingResult {
  /** 格子索引 → 按文字读出的色号与标准色 */
  overrides: Map<number, { code: string; hex: string }>;
  /** 文字无法识别的格子数 */
  unreadable: number;
  /** 读出了印字、且与颜色匹配结论不同的格子数（真正被文字改正的） */
  corrected: number;
  /** 读出了印字、且与颜色匹配结论一致的格子数（印证） */
  confirmed: number;
  /** 读出了印字但证据不足（字形打平，或色号离底色太远）而未采信、仍按颜色匹配的格子数 */
  untrusted: number;
  /** 文字与颜色匹配不一致的次数（色号 → 次数） */
  disagreements: Map<string, number>;
}

/**
 * 读格子里印的色号：
 *   1) 按**底色**把格子聚成簇——同一种珠子印的色号必然相同，底色比字形可靠得多
 *      （按字形聚类会把中绿 B08 与浅绿 B20 这种字形相近的格子并在一起，再统一判错）；
 *   2) 每簇用主导底色生成颜色短名单（并补上图纸色号清单区里出现的色号）；
 *   3) 把短名单里每个色号的几种印法按若干字体、若干字号渲染成模板，与簇内抽样的
 *      格子比对（按高度归一化的光栅 + 孔洞差），取簇内**中位分**最低的色号；
 *   4) 分数低于 TEXT_ACCEPT 才采纳——图纸上印的字优先于颜色匹配，这就是本功能的意义：
 *      外来图纸的颜色经 JPEG/扫描会有色差，最近邻会选错，而印着的色号是作者写死的。
 */
function readPrintedCodes(
  cells: TextCellSample[],
  colorSystem: ColorSystem,
  legendHexes: string[],
  renderTemplate: TextTemplateRenderer,
): TextReadingResult {
  const overrides = new Map<number, { code: string; hex: string }>();
  const disagreements = new Map<string, number>();
  let unreadable = 0;
  let corrected = 0;
  let confirmed = 0;
  let untrusted = 0;
  if (!cells.length) return { overrides, unreadable, corrected, confirmed, untrusted, disagreements };

  // 同一张图纸的字号一致，用所有格子的中位字高推算基准字号，模板也能跨簇复用
  const heights = cells.map(cell => cell.mask.by1 - cell.mask.by0 + 1).sort((a, b) => a - b);
  const capHeight = heights[Math.floor(heights.length / 2)] || 1;
  const baseSize = Math.max(6, Math.round(capHeight / 0.72));
  const sizes: number[] = [];
  for (let size = baseSize - TEXT_SIZE_SPAN; size <= baseSize + TEXT_SIZE_SPAN; size++) {
    if (size >= 5) sizes.push(size);
  }

  // 1) 按底色聚类：先按 4 bit/通道分桶，再把均值相近的桶合并
  interface FillCluster {
    members: TextCellSample[];
    sum: [number, number, number];
  }
  const clusters: FillCluster[] = [];
  const buckets = new Map<number, TextCellSample[]>();
  for (const cell of cells) {
    const key = packRgb(cell.fill[0] >> 4, cell.fill[1] >> 4, cell.fill[2] >> 4);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(cell);
    else buckets.set(key, [cell]);
  }
  buckets.forEach(bucket => {
    const sum: [number, number, number] = [0, 0, 0];
    for (const cell of bucket) {
      sum[0] += cell.fill[0];
      sum[1] += cell.fill[1];
      sum[2] += cell.fill[2];
    }
    const count = bucket.length;
    const mean: [number, number, number] = [sum[0] / count, sum[1] / count, sum[2] / count];
    for (const cluster of clusters) {
      const size = cluster.members.length;
      const clusterMean: [number, number, number] = [
        cluster.sum[0] / size,
        cluster.sum[1] / size,
        cluster.sum[2] / size,
      ];
      if (rgbDistance(mean, clusterMean) > TEXT_FILL_MERGE) continue;
      cluster.members.push(...bucket);
      cluster.sum[0] += sum[0];
      cluster.sum[1] += sum[1];
      cluster.sum[2] += sum[2];
      return;
    }
    clusters.push({ members: [...bucket], sum });
  });

  const codeHexMap = buildCodeHexMap(colorSystem);
  const templateCache = new Map<string, TextShape | null>();
  const renderShape = (text: string, fontFamily: string, size: number): TextShape | null => {
    const key = `${text}|${fontFamily}|${size}`;
    const cached = templateCache.get(key);
    if (cached !== undefined) return cached;
    let shape: TextShape | null = null;
    try {
      const mask = maskFromTemplate(renderTemplate(text, fontFamily, size));
      shape = mask ? textShapeOf(mask) : null;
    } catch {
      shape = null;
    }
    templateCache.set(key, shape);
    return shape;
  };

  for (const cluster of clusters) {
    const { members } = cluster;
    // 2) 簇的平均底色（比取众数更稳，能容忍 JPEG 把同一种珠子抖成好几个近似色）
    const dominantFill: [number, number, number] = [
      cluster.sum[0] / members.length,
      cluster.sum[1] / members.length,
      cluster.sum[2] / members.length,
    ];

    const shortlist = buildCodeShortlist(dominantFill, legendHexes, colorSystem);
    if (!shortlist.length) {
      unreadable += members.length;
      continue;
    }

    // 簇内均匀抽样（上限 TEXT_SAMPLE_LIMIT），中位分足以抵抗 JPEG 噪点
    const step = Math.max(1, Math.floor(members.length / TEXT_SAMPLE_LIMIT));
    const samples: TextCellSample[] = [];
    for (let i = 0; i < members.length && samples.length < TEXT_SAMPLE_LIMIT; i += step) {
      samples.push(members[i]);
    }
    if (!samples.length) samples.push(members[0]);

    // 3) 每个色号试它的几种印法 × 若干字体 × 若干字号，取该格子的最好分数
    const codeScores = new Map<string, number[]>();
    for (const sample of samples) {
      const cellShape = textShapeOf(sample.mask);
      for (const entry of shortlist) {
        let best = Infinity;
        for (const form of printedCodeForms(entry.code)) {
          for (const fontFamily of TEXT_FONT_FAMILIES) {
            for (const size of sizes) {
              const template = renderShape(form, fontFamily, size);
              if (!template) continue;
              const score = textScore(cellShape, template);
              if (score < best) best = score;
            }
          }
        }
        if (best === Infinity) continue;
        const scores = codeScores.get(entry.code);
        if (scores) scores.push(best);
        else codeScores.set(entry.code, [best]);
      }
    }

    let winner: string | null = null;
    let winnerScore = Infinity;
    codeScores.forEach((scores, code) => {
      const median = medianOf(scores);
      if (median < winnerScore) {
        winnerScore = median;
        winner = code;
      }
    });

    // 4) 分数不够好、或者这一簇太小没有旁证，就不采信文字，保留颜色匹配
    if (winner === null || winnerScore >= TEXT_ACCEPT || members.length < TEXT_MIN_CLUSTER) {
      unreadable += members.length;
      continue;
    }
    const hex = codeHexMap.get(winner);
    if (!hex) {
      unreadable += members.length;
      continue;
    }

    // 5) 字形证据必须真的比「颜色结论自身的字形得分」更好，才允许覆盖颜色：
    //    两者打平时说明是字形噪声主导（实测「H2」0.226 对「H1」0.222），应当相信颜色
    const colorCode = samples[0].colorCode;
    const colorScores = codeScores.get(colorCode);
    if (winner !== colorCode && colorScores && medianOf(colorScores) - winnerScore < TEXT_SCORE_MARGIN) {
      untrusted += members.length;
      continue;
    }

    // 6) 颜色合理性闸门：24×12 的二值光栅只有 12% 量级的区分力（正确候选与误读候选
    //    的分差就是这么小），不足以单独支撑「推翻颜色结论」，所以还要求胜出色号的标准色
    //    离这一簇的实测底色足够近。真正需要文字的场合（外来图纸色差）gap 很小，
    //    而 JPEG 糊出来的误读 gap 很大，见 TEXT_COLOR_SLACK。
    const winnerRgb = hexToRgbTuple(hex);
    if (winnerRgb) {
      const bestGap = shortlist[0].distance;
      const winnerGap = rgbDistance(dominantFill, winnerRgb);
      const gapLimit = Math.max(bestGap + TEXT_COLOR_SLACK, bestGap * TEXT_COLOR_RELATIVE);
      if (winnerGap > gapLimit) {
        untrusted += members.length;
        continue;
      }
    }

    for (const cell of members) {
      overrides.set(cell.index, { code: winner, hex });
      if (cell.colorCode !== winner && cell.colorCode !== '?') {
        corrected++;
        const key = `${winner} / ${cell.colorCode}`;
        disagreements.set(key, (disagreements.get(key) || 0) + 1);
      } else {
        confirmed++;
      }
    }
  }

  return { overrides, unreadable, corrected, confirmed, untrusted, disagreements };
}

/* ------------------------------------------------------------------ *
 * 5. 主流程
 * ------------------------------------------------------------------ */

/** 解析选项（都是可选的，不影响默认行为） */
export interface BlueprintParseOptions {
  /** 自定义文字模板渲染器：离线（node）测试没有 canvas 文字能力时传入 */
  renderTemplate?: TextTemplateRenderer;
  /** 关掉「读印字」，只按颜色匹配（对照/调试用） */
  disableTextReading?: boolean;
}

export async function parseBlueprintImage(
  imageSrc: string,
  gridRect: PixelRect,
  paletteRect: PixelRect,
  colorSystem: ColorSystem = 'MARD',
  options: BlueprintParseOptions = {},
): Promise<BlueprintParseResult> {
  const warnings: string[] = [];
  const source = await readImagePixels(imageSrc);

  const gridRegion = extractRegion(source.data, source.width, source.height, gridRect);
  if (!gridRegion) throw new Error('图片区域太小或超出图片范围，请重新框选');

  // --- 外框 ---
  const frame = detectFrame(gridRegion);
  const box: Box = frame ?? {
    x: 0,
    y: 0,
    width: gridRegion.w,
    height: gridRegion.h,
  };
  if (!frame) {
    warnings.push('未在图片区域里识别到网格外框，已按所选范围的边缘推算格子，结果可能略有偏差。');
  }

  // --- 格子数量 ---
  const columns = detectCellCount(lineProfile(gridRegion, box, 'x'));
  const rows = detectCellCount(lineProfile(gridRegion, box, 'y'));
  if (!columns || !rows) {
    throw new Error('无法从图片区域中识别出网格，请确认所选区域包含了完整的格子图案');
  }

  // --- 色号清单区域的候选颜色 ---
  const paletteRegion = extractRegion(source.data, source.width, source.height, paletteRect);
  let paletteHexes: string[] = [];
  if (paletteRegion) {
    paletteHexes = Array.from(new Set(detectSwatches(paletteRegion).map(swatch => swatch.hex)));
  }
  if (paletteHexes.length < 2) {
    warnings.push('未能从色号清单区域解析出颜色块，将直接按网格自身的颜色统计（建议重新框选清单区域）。');
    paletteHexes = [];
  }

  const { grid, textCells } = sampleGrid(gridRegion, box, columns, rows, colorSystem);

  // --- 读格子里印着的色号，用文字盖掉颜色匹配 ---
  if (textCells.length && !options.disableTextReading) {
    const renderer = options.renderTemplate ?? renderTextTemplateWithCanvas;
    const reading = readPrintedCodes(textCells, colorSystem, paletteHexes, renderer);

    reading.overrides.forEach((override, index) => {
      const row = Math.floor(index / columns);
      const column = index - row * columns;
      const cell = grid[row]?.[column];
      if (!cell) return;
      cell.key = override.code;
      cell.color = override.hex;
    });

    if (reading.corrected + reading.confirmed) {
      warnings.push(
        `已从图纸上读出 ${reading.corrected + reading.confirmed} 个格子的印字色号，其中 ${reading.corrected} 个与颜色匹配结论不同，已按印字改正。`,
      );
    }
    if (reading.disagreements.size) {
      const detail = Array.from(reading.disagreements.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pair, count]) => `${pair} × ${count}`)
        .join('、');
      warnings.push(`以下格子的印字与颜色匹配结论不同（按印字）：${detail}`);
    }
    if (reading.unreadable) {
      warnings.push(`有 ${reading.unreadable} 个格子印的字没能识别，这些格子仍按颜色匹配。`);
    }
    if (reading.untrusted) {
      warnings.push(
        `有 ${reading.untrusted} 个格子读出的印字证据不足（与颜色结论的字形得分相当，或色号离格子颜色太远），未采信，仍按颜色匹配。`,
      );
    }
  } else if (columns * rows > TEXT_CELL_LIMIT && !options.disableTextReading) {
    warnings.push('图纸格子太多，已跳过「读印字」，直接按颜色匹配。');
  }

  const colorCounts: Record<string, { count: number; color: string }> = {};
  let totalBeadCount = 0;
  grid.forEach(row => {
    row.forEach(cell => {
      if (cell.isExternal) return;
      const key = cell.color.toUpperCase();
      if (!colorCounts[key]) colorCounts[key] = { count: 0, color: cell.color };
      colorCounts[key].count += 1;
      totalBeadCount += 1;
    });
  });

  if (!totalBeadCount) {
    throw new Error('解析结果里没有任何珠子，请确认所选的图片区域包含格子图案');
  }

  return {
    mappedPixelData: grid,
    gridDimensions: { N: columns, M: rows },
    colorCounts,
    totalBeadCount,
    paletteHexes,
    warnings,
  };
}

/**
 * 在给定的格子范围里逐格取色。
 *
 * 每格内缩一点后统计各颜色出现次数：
 *   - 出现最多的颜色即为该格底色（图纸的填充是纯色，占比通常远高于文字/水印）
 *   - 深色墨迹占比用来判断「这一格到底有没有色号文字」，从而区分白色珠子与图纸背景
 *   - 底色随后吸附到色号表里最接近的标准色
 *
 * 注意：这里**不用**色号清单区的候选色去改写格子颜色。清单区可能识别不全
 * （近白色块与白底几乎同色），一旦某个清单色离真正的格子底色更近，
 * 就会把大片格子改判成另一个色号；格子自身的众数颜色才是可靠依据。
 */
function sampleGrid(
  gridRegion: { gray: Float32Array; rgb: Uint8ClampedArray; w: number; h: number },
  box: Box,
  columns: number,
  rows: number,
  colorSystem: ColorSystem,
): { grid: MappedPixel[][]; textCells: TextCellSample[] } {
  const { gray, rgb, w } = gridRegion;
  const cellWidth = box.width / columns;
  const cellHeight = box.height / rows;
  const inset = Math.max(1, Math.floor(Math.min(cellWidth, cellHeight) * 0.12));
  // 找色号文字时要去掉的一圈边框（格线 + 抗锯齿），比取色用的内缩小一些，
  // 保证印在格子里的字不会被裁掉
  const ring = Math.max(TEXT_RING_MIN, Math.round(Math.min(cellWidth, cellHeight) * TEXT_RING_RATIO));
  const collectText = columns * rows <= TEXT_CELL_LIMIT;
  const textCells: TextCellSample[] = [];

  interface CellSample {
    color: [number, number, number];
    inkFraction: number;
  }

  const samples: CellSample[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowSamples: CellSample[] = [];
    const y0 = Math.round(box.y + r * cellHeight) + inset;
    const y1 = Math.round(box.y + (r + 1) * cellHeight) - inset - 1;
    for (let c = 0; c < columns; c++) {
      const x0 = Math.round(box.x + c * cellWidth) + inset;
      const x1 = Math.round(box.x + (c + 1) * cellWidth) - inset - 1;

      // 颜色按 8×8×8 的粗桶投票，桶内再求平均：
      //   - 图纸底色是大片纯色，即使 JPEG 抖动把数值打散，同一个桶里仍然最密集
      //   - 格内的色号文字、水印只占少数像素，投不过底色
      //   - 桶内求平均可以把抖动「平均掉」，比直接取众数精确得多
      const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
      let ink = 0;
      let total = 0;

      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= gridRegion.h) continue;
        const rowOffset = y * w;
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= gridRegion.w) continue;
          const index = rowOffset + x;
          const r = rgb[index * 3];
          const g = rgb[index * 3 + 1];
          const b = rgb[index * 3 + 2];
          const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          const bin = bins.get(key);
          if (bin) {
            bin.count++;
            bin.r += r;
            bin.g += g;
            bin.b += b;
          } else {
            bins.set(key, { count: 1, r, g, b });
          }
          if (gray[index] < INK_LUMA) ink++;
          total++;
        }
      }

      if (!total) {
        rowSamples.push({ color: [255, 255, 255], inkFraction: 0 });
        continue;
      }

      // 投票时按「桶 + 相邻桶」合并计票：JPEG 会把同一个底色抖到好几个相邻桶里，
      // 只看单个桶会让「纯黑/纯白的文字」这种不受抖动影响的桶反超底色。
      // 合并计票只用来圈定「哪个色簇最大」，真正的取色种子仍是该簇里最大的那个桶，
      // 否则贴着底色的抗锯齿桶会借着底色的票数爬到第一名。
      const entries: Array<{ br: number; bg: number; bb: number; bin: { count: number; r: number; g: number; b: number } }> = [];
      bins.forEach((bin, key) => {
        entries.push({ br: (key >> 10) & 31, bg: (key >> 5) & 31, bb: key & 31, bin });
      });

      let bestMerged = -1;
      let bestSeed: { count: number; r: number; g: number; b: number } | null = null;
      let fallbackMerged = -1;
      let fallbackSeed: { count: number; r: number; g: number; b: number } | null = null;
      for (const seed of entries) {
        let merged = 0;
        let topBin = seed.bin;
        for (const other of entries) {
          if (Math.abs(seed.br - other.br) <= 1 && Math.abs(seed.bg - other.bg) <= 1 && Math.abs(seed.bb - other.bb) <= 1) {
            merged += other.bin.count;
            if (other.bin.count > topBin.count) topBin = other.bin;
          }
        }
        const binLuma = luma(topBin.r / topBin.count, topBin.g / topBin.count, topBin.b / topBin.count);
        const isTextColor = binLuma < 40 || binLuma > 238;
        if (merged > bestMerged) {
          bestMerged = merged;
          bestSeed = topBin;
        }
        if (!isTextColor && merged > fallbackMerged) {
          fallbackMerged = merged;
          fallbackSeed = topBin;
        }
      }

      // 深色珠子上的色号文字是白字、浅色珠子上是黑字。若冠军是「文字色」
      // （极暗或极白）而另有可观的非文字簇，改用后者。
      let best = bestSeed ?? { count: 1, r: 255, g: 255, b: 255 };
      if (fallbackSeed && fallbackSeed !== best && fallbackMerged >= total * 0.25) {
        const bestLuma = luma(best.r / best.count, best.g / best.count, best.b / best.count);
        if (bestLuma < 40 || bestLuma > 238) best = fallbackSeed;
      }

      // 第二轮：把冠军桶附近（距离 ≤ 6）的像素一起平均，抹平 JPEG 的抖动
      const seedR = best.r / best.count;
      const seedG = best.g / best.count;
      const seedB = best.b / best.count;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let nearCount = 0;
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= gridRegion.h) continue;
        const rowOffset = y * w;
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= gridRegion.w) continue;
          const index = rowOffset + x;
          const r = rgb[index * 3];
          const g = rgb[index * 3 + 1];
          const b = rgb[index * 3 + 2];
          const dr = r - seedR;
          const dg = g - seedG;
          const db = b - seedB;
          if (dr * dr + dg * dg + db * db <= 36) {
            sumR += r;
            sumG += g;
            sumB += b;
            nearCount++;
          }
        }
      }

      const color: [number, number, number] =
        nearCount > 0
          ? [Math.round(sumR / nearCount), Math.round(sumG / nearCount), Math.round(sumB / nearCount)]
          : [Math.round(seedR), Math.round(seedG), Math.round(seedB)];
      rowSamples.push({
        color,
        inkFraction: ink / total,
      });

      // 顺便把这一格里「与底色不同」的笔画抠出来，交给文字识别去读印着的色号
      if (collectText) {
        const fullX0 = Math.round(box.x + c * cellWidth) + ring;
        const fullY0 = Math.round(box.y + r * cellHeight) + ring;
        const fullX1 = Math.round(box.x + (c + 1) * cellWidth) - 1 - ring;
        const fullY1 = Math.round(box.y + (r + 1) * cellHeight) - 1 - ring;
        if (
          fullX0 >= 0 &&
          fullY0 >= 0 &&
          fullX1 < gridRegion.w &&
          fullY1 < gridRegion.h &&
          fullX1 - fullX0 >= 3 &&
          fullY1 - fullY0 >= 3
        ) {
          const mask = extractGlyphMask(gridRegion, fullX0, fullY0, fullX1, fullY1, luma(color[0], color[1], color[2]));
          if (mask) {
            const fraction = mask.ink / (mask.w * mask.h);
            const bboxW = mask.bx1 - mask.bx0 + 1;
            const bboxH = mask.by1 - mask.by0 + 1;
            const accepted =
              fraction >= TEXT_MIN_FRACTION &&
              fraction <= TEXT_MAX_FRACTION &&
              bboxH <= mask.h * TEXT_MAX_BBOX_RATIO &&
              mask.ink / (bboxW * bboxH) >= TEXT_MIN_DENSITY;
            if (accepted) {
              const [cr, cg, cb] = canonicalizeRgb(color);
              const hex = rgbToHex(cr, cg, cb);
              const colorCode = getColorKeyByHex(hex.toUpperCase(), colorSystem);
              textCells.push({
                index: r * columns + c,
                fill: color,
                mask,
                colorCode,
              });
            }
          }
        }
      }
    }
    samples.push(rowSamples);
  }

  // 图纸上有色号文字时，用「墨迹占比」区分白色珠子与背景；
  // 整幅图都没有文字时（未勾选显示色号），退化为「出现最多的近白颜色是背景」
  const anyText = samples.some(row => row.some(sample => sample.inkFraction >= INK_FRACTION));
  let backgroundKey = -1;
  if (!anyText) {
    const whiteCounts = new Map<number, number>();
    samples.forEach(row =>
      row.forEach(sample => {
        const [r, g, b] = sample.color;
        if (r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE) {
          const key = packRgb(r, g, b);
          whiteCounts.set(key, (whiteCounts.get(key) || 0) + 1);
        }
      }),
    );
    let bestCount = -1;
    whiteCounts.forEach((count, key) => {
      if (count > bestCount) {
        bestCount = count;
        backgroundKey = key;
      }
    });
  }

  const grid = samples.map(row =>
    row.map(sample => {
      const [r, g, b] = sample.color;
      const rawNearWhite = r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE;
      // 用**未吸附**的底色判断背景：吸附后 #FFFFFF 与 #FEFFFF 可能落到同一个标准色，
      // 那样「白色珠子」和「图纸背景」就再也分不开了
      const isExternal = rawNearWhite
        ? anyText
          ? sample.inkFraction < INK_FRACTION
          : packRgb(r, g, b) === backgroundKey
        : false;
      // 吸附到色号表里的标准色，保证 getColorKeyByHex 能查到色号（抗 JPEG 噪点/抗锯齿）
      const [cr, cg, cb] = canonicalizeRgb(sample.color);
      const hex = rgbToHex(cr, cg, cb);
      return {
        key: getColorKeyByHex(hex.toUpperCase(), colorSystem),
        color: hex,
        isExternal,
      } as MappedPixel;
    }),
  );

  // 外部（背景）格不是珠子，格里的墨迹是边框/水印而不是色号；而且它们的底色是纯白，
  // 混进「白色珠子」那一簇会把这一簇的底色拉偏——实测外来图纸上 H02 因此被读成 T01。
  const beadTextCells = textCells.filter(cell => {
    const row = Math.floor(cell.index / columns);
    const column = cell.index - row * columns;
    return !grid[row]?.[column]?.isExternal;
  });

  return { grid, textCells: beadTextCells };
}

/** 把色号清单区域解析出的 hex 列表转成调色板对象（供页面挑选选中色） */
export function paletteHexesToColors(hexes: string[]): PaletteColor[] {
  return hexes.flatMap(hex => {
    const tuple = hexToRgbTuple(hex);
    if (!tuple) return [];
    return [
      {
        key: getColorKeyByHex(hex.toUpperCase(), 'MARD'),
        hex,
        rgb: { r: tuple[0], g: tuple[1], b: tuple[2] },
      },
    ];
  });
}
