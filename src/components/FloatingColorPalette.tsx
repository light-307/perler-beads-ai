'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { MappedPixel } from '../utils/pixelation';
import { TRANSPARENT_KEY } from '../utils/pixelEditingUtils';
import { ColorReplaceState } from '../hooks/useManualEditingState';
import { ColorSystem, getColorKeyByHex } from '../utils/colorSystemUtils';

interface FloatingColorPaletteProps {
  colors: { key: string; color: string }[];
  selectedColor: MappedPixel | null;
  onColorSelect: (colorData: { key: string; color: string; isExternal?: boolean }) => void;
  selectedColorSystem: ColorSystem;
  isEraseMode: boolean;
  onEraseToggle: () => void;
  fullPaletteColors: { key: string; color: string }[];
  showFullPalette: boolean;
  onToggleFullPalette: () => void;
  colorReplaceState: ColorReplaceState;
  onColorReplaceToggle: () => void;
  onColorReplace: (sourceColor: { key: string; color: string }, targetColor: { key: string; color: string }) => void;
  onHighlightColor: (colorHex: string) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
  isActive: boolean;
  onActivate: () => void;
  /** 豆仓库存表（色号 → 库存粒数）；不传或为 null 时不显示库存 */
  stockByCode?: Record<string, number> | null;
}

const FloatingColorPalette: React.FC<FloatingColorPaletteProps> = ({
  colors,
  selectedColor,
  onColorSelect,
  selectedColorSystem,
  isEraseMode,
  onEraseToggle,
  fullPaletteColors,
  showFullPalette,
  onToggleFullPalette,
  colorReplaceState,
  onColorReplaceToggle,
  onColorReplace,
  onHighlightColor,
  isOpen,
  onToggleOpen,
  isActive,
  onActivate,
  stockByCode = null
}) => {
  // 计算初始位置，确保左边缘在屏幕内（小屏幕时右边缘可以超出）
  const getInitialPosition = () => ({
    x: Math.max(0, Math.min(20, window.innerWidth - 280)), // 确保左边缘至少是0
    y: Math.max(0, Math.min(100, window.innerHeight - 400)) // 确保上边缘至少是0
  });
  
  const [position, setPosition] = useState({ x: 20, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const paletteRef = useRef<HTMLDivElement>(null);

  // 处理拖拽开始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!paletteRef.current) return;
    
    onActivate(); // 激活调色板，置于最上层
    const rect = paletteRef.current.getBoundingClientRect();
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
    e.preventDefault();
  }, [onActivate]);

  // 处理触摸开始
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!paletteRef.current) return;
    
    onActivate(); // 激活调色板，置于最上层
    const rect = paletteRef.current.getBoundingClientRect();
    const touch = e.touches[0];
    setIsDragging(true);
    setDragOffset({
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    });
    e.preventDefault();
  }, [onActivate]);

  // 处理移动
  useEffect(() => {
    const handleMove = (clientX: number, clientY: number) => {
      if (!isDragging) return;

      // 移除边界限制，允许自由拖动到任何位置
      const newX = clientX - dragOffset.x;
      const newY = clientY - dragOffset.y;

      setPosition({ x: newX, y: newY });
    };

    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handleMove(e.clientX, e.clientY);
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.touches.length > 0) {
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const handleEnd = () => {
      setIsDragging(false);
      // 恢复页面滚动
      document.body.style.overflow = '';
    };

    if (isDragging) {
      // 阻止页面滚动
      document.body.style.overflow = 'hidden';
      
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleEnd);
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleEnd);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleEnd);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleEnd);
        // 清理时恢复滚动
        document.body.style.overflow = '';
      };
    }
  }, [isDragging, dragOffset]);

  // 移除窗口大小变化时的边界调整，允许调色盘保持在任何位置

    // 每次打开调色盘时重置位置到屏幕内
  useEffect(() => {
    if (isOpen && typeof window !== 'undefined') {
      setPosition(getInitialPosition());
    }
  }, [isOpen]);

  // 处理颜色点击
  const handleColorClick = (colorData: { key: string; color: string }) => {
    if (colorReplaceState.isActive && colorReplaceState.step === 'select-target' && colorReplaceState.sourceColor) {
      // 执行颜色替换
      onColorReplace(colorReplaceState.sourceColor, colorData);
    } else {
      // 高亮颜色
      onHighlightColor(colorData.color);
      // 选择颜色
      onColorSelect(colorData);
    }
  };

  // ++ 字母筛选：按色号字母前缀（A / B / C …）过滤当前展示的色板 ++
  const [letterFilter, setLetterFilter] = useState<string>('all');

  const displayColors = useMemo(
    () => (showFullPalette ? fullPaletteColors : colors),
    [showFullPalette, fullPaletteColors, colors]
  );

  /** 取色号的字母前缀；无法识别时归入 '#' 组 */
  const letterOf = useCallback((code: string): string => {
    const match = /^[A-Za-z]+/.exec(code ?? '');
    return match ? match[0].toUpperCase() : '#';
  }, []);

  /** 当前展示色板里实际出现过的字母前缀 */
  const letterOptions = useMemo(() => {
    const letters = new Set<string>();
    displayColors.forEach(colorData => {
      letters.add(letterOf(getColorKeyByHex(colorData.color, selectedColorSystem)));
    });
    return Array.from(letters).sort((a, b) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b, 'en');
    });
  }, [displayColors, letterOf, selectedColorSystem]);

  /** 切换色板后，若当前筛选的字母已不存在则回到「全部」 */
  useEffect(() => {
    if (letterFilter !== 'all' && !letterOptions.includes(letterFilter)) {
      setLetterFilter('all');
    }
  }, [letterFilter, letterOptions]);

  const visibleColors = useMemo(
    () => (letterFilter === 'all'
      ? displayColors
      : displayColors.filter(colorData => letterOf(getColorKeyByHex(colorData.color, selectedColorSystem)) === letterFilter)),
    [displayColors, letterFilter, letterOf, selectedColorSystem]
  );

  /** 取某色号的豆仓库存；无豆仓数据或色号无法识别时返回 null（不显示） */
  const stockOfColor = useCallback((code: string): number | null => {
    if (!stockByCode || !code || code === '?') return null;
    return stockByCode[code] ?? 0;
  }, [stockByCode]);

  // 如果调色盘关闭，完全不渲染
  if (!isOpen) {
    return null;
  }

  return (
    <div
      ref={paletteRef}
      className={`fixed bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-600 select-none ${
        isActive ? 'z-[60]' : 'z-[50]'
      }`}
      style={{
        left: position.x,
        top: position.y,
        width: '320px',
        maxHeight: '400px'
      }}
      onClick={onActivate}
    >
      {/* 标题栏和控制按钮 */}
      <div
        className="flex items-center justify-between p-3 bg-gradient-to-r from-blue-500 to-purple-500 text-white rounded-t-xl cursor-move"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
      >
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L10 5.757v8.486zM16 18H9.071l6-6H16a2 2 0 012 2v2a2 2 0 01-2 2z" clipRule="evenodd" />
          </svg>
          <span className="text-sm font-medium">调色盘</span>
        </div>
        
        <div className="flex items-center gap-1">
          {/* 关闭按钮 */}
          <button
            onClick={onToggleOpen}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            title="关闭调色盘"
          >
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              className="h-4 w-4"
              fill="none" 
              viewBox="0 0 24 24" 
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="p-2.5 max-h-80 overflow-y-auto">
          {/* 模式状态指示器 */}
          {colorReplaceState.isActive && (
            <div className="mb-3 p-2 bg-orange-100 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-800 rounded-lg text-xs">
              <div className="flex items-center gap-1 text-orange-700 dark:text-orange-300">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                </svg>
                <span>
                  {colorReplaceState.step === 'select-source' ? '点击画布选择要替换的颜色' : '选择目标颜色'}
                </span>
              </div>
            </div>
          )}

          {/* 工具按钮行 */}
          <div className="flex gap-2 mb-3">
            {/* 橡皮擦按钮 */}
            <button
              onClick={() => handleColorClick({ key: TRANSPARENT_KEY, color: '#FFFFFF' })}
              className={`flex-1 p-2 rounded-lg border transition-all duration-200 flex items-center justify-center gap-1 text-xs ${
                selectedColor?.key === TRANSPARENT_KEY
                  ? 'bg-red-500 text-white border-red-500'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-red-50 dark:hover:bg-red-900/20'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              橡皮擦
            </button>

            {/* 一键擦除按钮 */}
            <button
              onClick={onEraseToggle}
              className={`flex-1 p-2 rounded-lg border transition-all duration-200 flex items-center justify-center gap-1 text-xs ${
                isEraseMode
                  ? 'bg-orange-500 text-white border-orange-500'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-orange-50 dark:hover:bg-orange-900/20'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              区域擦除
            </button>

            {/* 颜色替换按钮 */}
            <button
              onClick={onColorReplaceToggle}
              className={`flex-1 p-2 rounded-lg border transition-all duration-200 flex items-center justify-center gap-1 text-xs ${
                colorReplaceState.isActive
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              批量替换
            </button>
          </div>

          {/* 色板切换 */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={onToggleFullPalette}
              className="w-full text-xs py-2 px-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              {showFullPalette ? `当前色板 (${colors.length})` : `完整色板 (${fullPaletteColors.length})`}
            </button>
          </div>

          {/* ++ 字母筛选：仅在当前色板出现多个字母前缀时显示 ++ */}
          {letterOptions.length > 1 && (
            <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
              <button
                onClick={() => setLetterFilter('all')}
                className={`flex-shrink-0 px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  letterFilter === 'all'
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                全部
              </button>
              {letterOptions.map(letter => (
                <button
                  key={letter}
                  onClick={() => setLetterFilter(letter)}
                  className={`flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                    letterFilter === letter
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {letter}
                </button>
              ))}
            </div>
          )}

          {/* 颜色网格（色块下方常驻显示色号与豆仓库存） */}
          <div className="grid grid-cols-6 gap-1">
            {visibleColors.map((colorData) => {
              const isSelected = selectedColor?.key === colorData.key && selectedColor?.color === colorData.color;
              const displayKey = getColorKeyByHex(colorData.color, selectedColorSystem);
              const stock = stockOfColor(displayKey);
              
              return (
                <button
                  key={`${colorData.key}-${colorData.color}`}
                  onClick={() => handleColorClick(colorData)}
                  className={`flex flex-col items-center rounded-lg border-2 transition-all duration-200 hover:scale-110 ${
                    isSelected
                      ? 'border-blue-500 dark:border-blue-400 ring-2 ring-blue-200 dark:ring-blue-800 scale-110'
                      : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                  }`}
                  title={`${displayKey} (${colorData.color})${stock !== null ? ` · 豆仓库存 ${stock} 粒` : ''}`}
                >
                  {/* 色块 */}
                  <span
                    className="relative w-full aspect-square rounded-md"
                    style={{ backgroundColor: colorData.color }}
                  >
                    {/* 选中指示器 */}
                    {isSelected && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-2 h-2 bg-white rounded-full shadow-lg"></div>
                      </div>
                    )}
                  </span>

                  {/* 色块下方的色号 */}
                  <span className="w-full truncate text-center font-mono text-[10px] leading-tight py-0.5 text-gray-700 dark:text-gray-200">
                    {displayKey}
                  </span>

                  {/* ++ 色块下方的豆仓库存（只显示数字，完整信息见 title） ++ */}
                  {stock !== null && (
                    <span
                      className={`w-full truncate text-center text-[9px] leading-tight pb-0.5 tabular-nums ${
                        stock > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-500 dark:text-red-400'
                      }`}
                    >
                      {stock}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ++ 当前筛选字母下没有色号时的提示 ++ */}
          {visibleColors.length === 0 && (
            <p className="text-center text-xs text-gray-400 dark:text-gray-500 py-4">
              该字母下没有可选色号
            </p>
          )}

          {/* 当前选中颜色信息 */}
          {selectedColor && selectedColor.key !== TRANSPARENT_KEY && (
            <div className="mt-3 p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
              <div className="flex items-center gap-2 text-xs">
                <div
                  className="w-4 h-4 rounded border border-gray-300 dark:border-gray-500"
                  style={{ backgroundColor: selectedColor.color }}
                ></div>
                <span className="text-gray-700 dark:text-gray-300">
                  当前: {getColorKeyByHex(selectedColor.color, selectedColorSystem)}
                </span>
              </div>
            </div>
          )}
        </div>
    </div>
  );
};

export default FloatingColorPalette; 