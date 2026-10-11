'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PixelRect } from '../utils/blueprintParser';

interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BlueprintRegionModalProps {
  imageSrc: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (regions: { grid: PixelRect; palette: PixelRect }) => void | Promise<void>;
}

type Target = 'grid' | 'palette';

const MIN_SIZE = 0.01;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export default function BlueprintRegionModal({
  imageSrc,
  isOpen,
  onClose,
  onConfirm,
}: BlueprintRegionModalProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [gridRect, setGridRect] = useState<NormalizedRect | null>(null);
  const [paletteRect, setPaletteRect] = useState<NormalizedRect | null>(null);
  const [target, setTarget] = useState<Target>('grid');
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [isProcessing, setIsProcessing] = useState(false);

  // 每次打开（或换了图）都重新开始框选
  useEffect(() => {
    if (!isOpen) return;
    setGridRect(null);
    setPaletteRect(null);
    setDraft(null);
    setTarget('grid');
    setIsProcessing(false);
  }, [isOpen, imageSrc]);

  const draftRect = useMemo<NormalizedRect | null>(() => {
    if (!draft) return null;
    return {
      x: Math.min(draft.x0, draft.x1),
      y: Math.min(draft.y0, draft.y1),
      w: Math.abs(draft.x1 - draft.x0),
      h: Math.abs(draft.y1 - draft.y0),
    };
  }, [draft]);

  const pointerToNormalized = useCallback((event: React.PointerEvent): { x: number; y: number } => {
    const overlay = overlayRef.current;
    if (!overlay) return { x: 0, y: 0 };
    const bounds = overlay.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return { x: 0, y: 0 };
    return {
      x: clamp01((event.clientX - bounds.left) / bounds.width),
      y: clamp01((event.clientY - bounds.top) / bounds.height),
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (isProcessing) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    const point = pointerToNormalized(event);
    setDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!draft || isProcessing) return;
    event.preventDefault();
    const point = pointerToNormalized(event);
    setDraft({ ...draft, x1: point.x, y1: point.y });
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    if (!draft || isProcessing) return;
    event.preventDefault();
    const point = pointerToNormalized(event);
    const rect: NormalizedRect = {
      x: Math.min(draft.x0, point.x),
      y: Math.min(draft.y0, point.y),
      w: Math.abs(point.x - draft.x0),
      h: Math.abs(point.y - draft.y0),
    };
    setDraft(null);
    if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) return;
    if (target === 'grid') {
      setGridRect(rect);
      setTarget('palette');
    } else {
      setPaletteRect(rect);
    }
  };

  const handleConfirm = async () => {
    if (!gridRect || !paletteRect || isProcessing) return;
    const image = imageRef.current;
    const width = image?.naturalWidth || 0;
    const height = image?.naturalHeight || 0;
    if (!width || !height) {
      alert('图片尚未加载完成，请稍候再试');
      return;
    }
    const toPixelRect = (rect: NormalizedRect): PixelRect => ({
      x: Math.round(rect.x * width),
      y: Math.round(rect.y * height),
      width: Math.max(1, Math.round(rect.w * width)),
      height: Math.max(1, Math.round(rect.h * height)),
    });
    setIsProcessing(true);
    try {
      await onConfirm({ grid: toPixelRect(gridRect), palette: toPixelRect(paletteRect) });
    } finally {
      setIsProcessing(false);
    }
  };

  const renderRect = (rect: NormalizedRect | null, color: string, label: string, key: string) => {
    if (!rect) return null;
    const pixelWidth = Math.round(rect.w * natural.width);
    const pixelHeight = Math.round(rect.h * natural.height);
    return (
      <div
        key={key}
        className="absolute pointer-events-none"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
          border: `2px solid ${color}`,
          backgroundColor: `${color}22`,
          boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
        }}
      >
        <span
          className="absolute -top-0.5 left-0 text-[11px] font-medium text-white px-1.5 py-0.5 rounded-br whitespace-nowrap"
          style={{ backgroundColor: color }}
        >
          {label}
          {pixelWidth > 0 && pixelHeight > 0 ? ` ${pixelWidth}×${pixelHeight}` : ''}
        </span>
      </div>
    );
  };

  if (!isOpen) return null;

  const canConfirm = !!gridRect && !!paletteRect && !isProcessing;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-5xl w-full max-h-[92vh] flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            选择图片区域和色号清单区域
          </h2>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 选区切换 */}
        <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400 mr-1">
              在图片上拖拽框选：
            </span>
            <button
              onClick={() => setTarget('grid')}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                target === 'grid'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              1. 图片区域
              {gridRect ? ' ✓' : ''}
            </button>
            <button
              onClick={() => setTarget('palette')}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                target === 'palette'
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              2. 色号清单区域
              {paletteRect ? ' ✓' : ''}
            </button>
            <div className="flex-1" />
            <button
              onClick={() => {
                setGridRect(null);
                setPaletteRect(null);
                setDraft(null);
                setTarget('grid');
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              重新框选
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            图片区域：选中图纸上部的格子图案（尽量包含完整的黑色外框）；
            色号清单区域：选中图纸下部的色号清单。两块区域都需要框选。
          </p>
        </div>

        {/* 图片与选区画布 */}
        <div className="flex-1 overflow-auto p-4 bg-gray-100 dark:bg-gray-800 flex justify-center">
          <div className="relative inline-block leading-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imageRef}
              src={imageSrc}
              alt="拼豆图纸"
              draggable={false}
              onLoad={event =>
                setNatural({
                  width: event.currentTarget.naturalWidth || 0,
                  height: event.currentTarget.naturalHeight || 0,
                })
              }
              className="block max-w-full max-h-[58vh] select-none"
            />
            <div
              ref={overlayRef}
              className="absolute inset-0 cursor-crosshair"
              style={{ touchAction: 'none' }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {renderRect(gridRect, '#2563EB', '图片区域', 'grid')}
              {renderRect(paletteRect, '#059669', '色号清单区域', 'palette')}
              {renderRect(draftRect, target === 'grid' ? '#2563EB' : '#059669', '框选中', 'draft')}
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {gridRect && paletteRect
              ? '已框选完毕，点击「确认选择」开始解析'
              : `请先框选${gridRect ? '色号清单区域' : '图片区域'}`}
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="px-6 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {isProcessing ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  解析中...
                </>
              ) : (
                '确认选择'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
