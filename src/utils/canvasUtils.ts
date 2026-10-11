/**
 * 画布坐标计算工具函数
 */

/**
 * 计算预览画布的内部像素尺寸（canvas.width / canvas.height）。
 *
 * 格子少时固定 500px 宽；格子多时按「每个格子 6px、上限 1200px 或屏幕宽 90%」
 * 放大，并保证每个格子不小于 4px。高度严格按网格比例（M/N）推导，
 * 因此格子始终是正方形，不会出现拉伸/压扁。
 *
 * 注意：预览画布的 width/height 属性一旦缺失，浏览器会退回默认的 300×150，
 * 视觉上就是「又小又扁」。所有设置网格数据的入口都必须经过这里。
 */
export function computePreviewCanvasSize(N: number, M: number): { width: number; height: number } {
  // 网格尺寸非法时不参与计算，返回 1×1 交给调用方处理
  if (!Number.isFinite(N) || !Number.isFinite(M) || N < 1 || M < 1) {
    return { width: 1, height: 1 };
  }

  const baseWidth = 500;
  const minCellSize = 4; // 每个格子的最小尺寸（像素）
  const recommendedCellSize = 6; // 推荐的格子尺寸（像素）

  let outputWidth = baseWidth;

  if (N > 100) {
    const requiredWidthForMinSize = N * minCellSize;
    const requiredWidthForRecommendedSize = N * recommendedCellSize;

    // 使用推荐尺寸，但不超过屏幕宽度的90%（最大1200px）
    const maxWidth = typeof window !== 'undefined' ? Math.min(1200, window.innerWidth * 0.9) : 1200;
    outputWidth = Math.min(maxWidth, Math.max(baseWidth, requiredWidthForRecommendedSize));

    // 确保不小于最小要求
    outputWidth = Math.max(outputWidth, requiredWidthForMinSize);
  }

  // 按实际网格宽高比（M/N）计算画布高度，保证格子为正方形
  const outputHeight = Math.max(1, Math.round(outputWidth * (M / N)));

  return { width: Math.max(1, Math.round(outputWidth)), height: outputHeight };
}

/**
 * 将鼠标/触摸坐标转换为画布内的格子坐标
 * @param clientX 客户端X坐标
 * @param clientY 客户端Y坐标
 * @param canvas 画布元素
 * @param gridDimensions 网格尺寸
 * @returns 格子坐标 {i, j} 或 null（如果超出范围）
 */
export function clientToGridCoords(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  gridDimensions: { N: number; M: number }
): { i: number; j: number } | null {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const canvasX = (clientX - rect.left) * scaleX;
  const canvasY = (clientY - rect.top) * scaleY;

  const { N, M } = gridDimensions;
  const cellWidthOutput = canvas.width / N;
  const cellHeightOutput = canvas.height / M;

  const i = Math.floor(canvasX / cellWidthOutput);
  const j = Math.floor(canvasY / cellHeightOutput);

  // 检查是否在有效范围内
  if (i >= 0 && i < N && j >= 0 && j < M) {
    return { i, j };
  }

  return null;
}

/**
 * 检查触摸是否被认为是移动而不是点击
 * @param startPos 开始位置
 * @param currentPos 当前位置
 * @param threshold 移动阈值（像素）
 * @returns 是否是移动
 */
export function isTouchMove(
  startPos: { x: number; y: number },
  currentPos: { x: number; y: number },
  threshold: number = 10
): boolean {
  const dx = Math.abs(currentPos.x - startPos.x);
  const dy = Math.abs(currentPos.y - startPos.y);
  return dx > threshold || dy > threshold;
} 