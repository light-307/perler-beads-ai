'use client';

import React, { useRef, useEffect, TouchEvent, MouseEvent, useState } from 'react';
import { MappedPixel } from '../utils/pixelation';

interface PixelatedPreviewCanvasProps {
  mappedPixelData: MappedPixel[][] | null;
  gridDimensions: { N: number; M: number } | null;
  isManualColoringMode: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onInteraction: (
    clientX: number,
    clientY: number,
    pageX: number,
    pageY: number,
    isClick: boolean,
    isTouchEnd?: boolean
  ) => void;
  highlightColorKey?: string | null;
  onHighlightComplete?: () => void;
}

// 绘制像素化画布的函数
const drawPixelatedCanvas = (
  dataToDraw: MappedPixel[][],
  canvas: HTMLCanvasElement | null,
  dims: { N: number; M: number } | null,
  highlightColorKey?: string | null,
  isHighlighting?: boolean
) => {
  if (!canvas || !dims || !dataToDraw) {
    console.warn("drawPixelatedCanvas: Missing required parameters");
    return;
  }
  
  const pixelatedCtx = canvas.getContext('2d');
  if (!pixelatedCtx) {
    console.error("Failed to get 2D context for pixelated canvas");
    return;
  }

  // Respect current dark mode preference
  const isDarkMode = typeof window !== 'undefined' && document.documentElement.classList.contains('dark');

  // Define colors based on mode
  const externalBackgroundColor = isDarkMode ? '#374151' : '#F3F4F6'; // gray-700 : gray-100
  const gridLineColor = isDarkMode ? '#4B5563' : '#DDDDDD'; // gray-600 : lighter gray

  const { N, M } = dims;
  const outputWidth = canvas.width;
  const outputHeight = canvas.height;
  const cellWidthOutput = outputWidth / N;
  const cellHeightOutput = outputHeight / M;

  pixelatedCtx.clearRect(0, 0, outputWidth, outputHeight);
  pixelatedCtx.lineWidth = 0.5; // Keep line width thin

  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const cellData = dataToDraw[j]?.[i];
      if (!cellData) continue;

      const drawX = i * cellWidthOutput;
      const drawY = j * cellHeightOutput;

      // Fill cell color using mode-specific background for external cells
      if (cellData.isExternal) {
        pixelatedCtx.fillStyle = externalBackgroundColor;
      } else {
        pixelatedCtx.fillStyle = cellData.color;
      }
      pixelatedCtx.fillRect(drawX, drawY, cellWidthOutput, cellHeightOutput);

      // 如果正在高亮且当前单元格不是目标颜色，添加半透明黑色蒙版
      if (isHighlighting && highlightColorKey) {
        let shouldDim = false;
        
        if (cellData.isExternal) {
          // 外部单元格总是变深色（因为它们不是要高亮的颜色）
          shouldDim = true;
        } else {
          // 内部单元格：如果颜色不匹配则变深色
          shouldDim = cellData.color.toUpperCase() !== highlightColorKey.toUpperCase();
        }
        
        if (shouldDim) {
          pixelatedCtx.fillStyle = 'rgba(0, 0, 0, 0.6)'; // 60% 透明度的黑色蒙版
          pixelatedCtx.fillRect(drawX, drawY, cellWidthOutput, cellHeightOutput);
        }
      }

      // Draw grid lines using mode-specific color
      pixelatedCtx.strokeStyle = gridLineColor;
      pixelatedCtx.strokeRect(drawX + 0.5, drawY + 0.5, cellWidthOutput, cellHeightOutput);
    }
  }
};

const PixelatedPreviewCanvas: React.FC<PixelatedPreviewCanvasProps> = ({
  mappedPixelData,
  gridDimensions,
  isManualColoringMode,
  canvasRef,
  onInteraction,
  highlightColorKey,
  onHighlightComplete,
}) => {
  const [darkModeState, setDarkModeState] = useState<boolean | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number; pageX: number; pageY: number } | null>(null);
  const touchMovedRef = useRef<boolean>(false);
  const [isHighlighting, setIsHighlighting] = useState(false);
  // 画布显示尺寸（用于对齐坐标轴标签）
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);

  // Effect to detect dark mode changes and update state
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const checkDarkMode = () => {
        const isDark = document.documentElement.classList.contains('dark');
        // Only update state if it actually changes
        if (isDark !== darkModeState) {
            setDarkModeState(isDark);
        }
    };

    // Initial check
    checkDarkMode();

    // Use MutationObserver to watch for class changes on <html>
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Cleanup observer on component unmount
    return () => observer.disconnect();

  }, [darkModeState]); // Depend on darkModeState to re-run if needed externally

  // 监听画布显示尺寸，用于在预览图周围渲染对齐的横纵轴坐标标签
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        setDisplaySize(prev => {
          if (prev && Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5) {
            return prev;
          }
          return { width: rect.width, height: rect.height };
        });
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [canvasRef, mappedPixelData, gridDimensions]);

  // Update useEffect for drawing to depend on darkModeState as well
  useEffect(() => {
    // Ensure darkModeState is not null before drawing
    if (mappedPixelData && gridDimensions && canvasRef.current && darkModeState !== null) {
      console.log(`Redrawing canvas, dark mode: ${darkModeState}`); // Log redraw trigger
      drawPixelatedCanvas(mappedPixelData, canvasRef.current, gridDimensions, highlightColorKey, isHighlighting);
    }
  }, [mappedPixelData, gridDimensions, canvasRef, darkModeState, highlightColorKey, isHighlighting]); // Add darkModeState dependency

  // 处理高亮效果
  useEffect(() => {
    if (highlightColorKey && mappedPixelData && gridDimensions) {
      setIsHighlighting(true);
      // 0.3秒后结束高亮
      const timer = setTimeout(() => {
        setIsHighlighting(false);
        onHighlightComplete?.();
      }, 300);

      return () => clearTimeout(timer);
    }
  }, [highlightColorKey, mappedPixelData, gridDimensions, onHighlightComplete]);

  // --- 鼠标事件处理 ---
  
  // 鼠标移动时显示提示
  const handleMouseMove = (event: MouseEvent<HTMLCanvasElement>) => {
    // 只有在非手动模式下才通过mousemove显示tooltip，避免干扰手动上色
    if (!isManualColoringMode) {
        onInteraction(event.clientX, event.clientY, event.pageX, event.pageY, false);
    }
  };

  // 鼠标离开时隐藏提示
  const handleMouseLeave = () => {
    // 鼠标离开时总是隐藏tooltip
    onInteraction(0, 0, 0, 0, false, true);
  };

  // 鼠标点击处理（用于手动上色模式）
  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    // 鼠标点击行为保持不变：
    // 手动模式下：上色
    // 非手动模式下：切换tooltip
    onInteraction(event.clientX, event.clientY, event.pageX, event.pageY, isManualColoringMode);
  };

  // --- 触摸事件处理 ---
  // 用于检测触摸移动的参考
  const handleTouchStart = (event: TouchEvent<HTMLCanvasElement>) => {
    const touch = event.touches[0];
    if (!touch) return;

    // 记录起始位置并重置移动标志
    touchStartPosRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      pageX: touch.pageX,
      pageY: touch.pageY
    };
    touchMovedRef.current = false;

    // 在非手动模式下，触摸开始时仍然可以立即显示/切换tooltip，提供即时反馈
    if (!isManualColoringMode) {
        onInteraction(touch.clientX, touch.clientY, touch.pageX, touch.pageY, false);
    }
    // 注意：此处不再触发手动上色 (isClick: true)
  };
  
  // 触摸移动时检测是否需要隐藏提示
  const handleTouchMove = (event: TouchEvent<HTMLCanvasElement>) => {
    const touch = event.touches[0];
    if (!touch || !touchStartPosRef.current) return;
    
    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
    
    // 如果移动超过阈值，则标记为已移动，并隐藏tooltip
    // 增加一个稍大的阈值，以更好地区分点击和微小的手指抖动/滑动意图
    if (!touchMovedRef.current && (dx > 10 || dy > 10)) {
      touchMovedRef.current = true;
      // 一旦确定是移动，就隐藏tooltip
      onInteraction(0, 0, 0, 0, false, true);
    }
  };
  
  // 触摸结束时不再自动隐藏提示框
  const handleTouchEnd = () => {
    // 检查是否是手动模式，并且触摸没有移动（判定为点击）
    if (isManualColoringMode && !touchMovedRef.current && touchStartPosRef.current) {
      // 使用触摸开始时的坐标来执行上色操作
      const { x, y, pageX, pageY } = touchStartPosRef.current;
      onInteraction(x, y, pageX, pageY, true); // isClick: true 表示执行上色
    }
    // 如果是非手动模式下的点击 (isManualColoringMode=false, touchMovedRef=false)
    // Tooltip 的显示/隐藏切换已在 touchstart 处理，touchend 时无需额外操作

    // 重置触摸状态
    touchStartPosRef.current = null;
    touchMovedRef.current = false;
  };

  // 计算坐标轴标签：与下载图纸默认参数一致（gridInterval: 10，标注首尾 + 每 10 个）
  const N = gridDimensions?.N ?? 0;
  const M = gridDimensions?.M ?? 0;
  const AXIS_LABEL_STEP = 10;
  const columnStep = AXIS_LABEL_STEP;
  const rowStep = AXIS_LABEL_STEP;

  // 生成轴标签：标注第 1 个、每 step 个、以及最后一个（末尾过近时省略以免重叠）
  const buildAxisLabels = (count: number, step: number): number[] => {
    const labels: number[] = [];
    for (let i = 0; i < count; i++) {
      if (i === 0 || (i + 1) % step === 0) {
        labels.push(i + 1);
      }
    }
    if (count > 1 && count - (labels[labels.length - 1] ?? 0) > 1) {
      labels.push(count);
    }
    return labels;
  };
  const columnLabels = buildAxisLabels(N, columnStep);
  const rowLabels = buildAxisLabels(M, rowStep);

  const labelCls = 'absolute font-mono leading-none text-[10px] text-gray-500 dark:text-gray-400 select-none pointer-events-none';

  return (
    <div
      className="relative inline-block align-middle max-w-full"
      style={{ margin: '20px 8px 8px 28px' }}
    >
      {/* 顶部横轴坐标（列号） */}
      {displaySize && N > 0 && (
        <div
          className="absolute left-0"
          style={{ bottom: '100%', width: displaySize.width, height: 16 }}
          aria-hidden
        >
          {columnLabels.map((col) => (
            <span
              key={col}
              className={labelCls}
              style={{
                left: ((col - 0.5) * displaySize.width) / N,
                top: 8,
                transform: 'translate(-50%, -50%)',
              }}
            >
              {col}
            </span>
          ))}
        </div>
      )}
      {/* 左侧纵轴坐标（行号） */}
      {displaySize && M > 0 && (
        <div
          className="absolute top-0"
          style={{ right: '100%', width: 24, height: displaySize.height }}
          aria-hidden
        >
          {rowLabels.map((row) => (
            <span
              key={row}
              className={labelCls}
              style={{
                top: ((row - 0.5) * displaySize.height) / M,
                left: 12,
                transform: 'translate(-50%, -50%)',
              }}
            >
              {row}
            </span>
          ))}
        </div>
      )}
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd} // 添加 onTouchCancel 以处理触摸中断的情况
        className={`border border-gray-300 dark:border-gray-600 max-w-full h-auto rounded block ${
          isManualColoringMode ? 'cursor-pointer' : 'cursor-grab' // 改为 grab 光标提示可以拖动
        }`}
        style={{
          imageRendering: 'pixelated',
          // touchAction: 'none' // 移除此行以允许页面滚动和缩放
        }}
      />
    </div>
  );
};

export default PixelatedPreviewCanvas; 