// 生成作品缩略图（PNG data URL）。
//
// "我的作品"列表里每个作品都要显示一张预览图。直接把原图（0.3–4MB）当缩略图
// 会让列表接口和流量都很难看，所以在浏览器端就地按调色板画一张小图上传。
//
// 注意：只允许在浏览器里调用（依赖 document / canvas）。

import type { MappedPixel } from './pixelation';

/** 缩略图最长边，320px 足够列表卡片清晰显示，PNG 一般只有几 KB。 */
const DEFAULT_MAX_SIZE = 320;

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const value = (hex ?? '').replace('#', '').trim();
  if (value.length === 3) {
    return {
      r: parseInt(value[0] + value[0], 16),
      g: parseInt(value[1] + value[1], 16),
      b: parseInt(value[2] + value[2], 16),
    };
  }
  if (value.length >= 6) {
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

/**
 * 把像素网格画成一张 PNG 缩略图。
 *
 * @param pixels `MappedPixel[][]`，行优先
 * @param maxSize 输出图最长边
 * @returns PNG data URL；环境不支持 canvas 或网格为空时返回 null
 */
export async function createProjectThumbnail(
  pixels: MappedPixel[][] | null | undefined,
  maxSize: number = DEFAULT_MAX_SIZE
): Promise<string | null> {
  if (!pixels || pixels.length === 0 || typeof document === 'undefined') return null;

  const M = pixels.length;
  const N = pixels[0]?.length ?? 0;
  if (N === 0) return null;

  try {
    // 先在 1:1 的画布上把每个格子点成一个像素，再整体放大，避免逐格绘制 6 万次
    const source = document.createElement('canvas');
    source.width = N;
    source.height = M;
    const sourceCtx = source.getContext('2d');
    if (!sourceCtx) return null;

    const imageData = sourceCtx.createImageData(N, M);
    const data = imageData.data;

    for (let row = 0; row < M; row += 1) {
      const line = pixels[row];
      for (let col = 0; col < N; col += 1) {
        const cell = line?.[col];
        const offset = (row * N + col) * 4;
        if (!cell || cell.isExternal) {
          // 外部/背景格输出为透明，缩略图只突出作品主体
          data[offset + 3] = 0;
          continue;
        }
        const { r, g, b } = parseHexColor(cell.color);
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
    }
    sourceCtx.putImageData(imageData, 0, 0);

    const scale = Math.min(maxSize / N, maxSize / M, 8);
    const targetWidth = Math.max(1, Math.round(N * scale));
    const targetHeight = Math.max(1, Math.round(M * scale));

    const target = document.createElement('canvas');
    target.width = targetWidth;
    target.height = targetHeight;
    const targetCtx = target.getContext('2d');
    if (!targetCtx) return null;

    // 保持像素画的硬边，不要被浏览器插值糊掉
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.drawImage(source, 0, 0, targetWidth, targetHeight);

    return target.toDataURL('image/png');
  } catch (error) {
    console.warn('[projectThumbnail] 生成缩略图失败：', error);
    return null;
  }
}
