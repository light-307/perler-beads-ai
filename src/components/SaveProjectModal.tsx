'use client';

// 「保存到云端」弹窗。
//
// 职责：把编辑器里的当前状态（参数 + 索引压缩网格 + 原图 + 缩略图）打包成一次
// 请求发出去。网格与缩略图都在这里现算，page.tsx 只负责把状态递进来。

import React, { useEffect, useMemo, useState } from 'react';
import { ApiRequestError, createProject, updateProject } from '../utils/apiClient';
import { encodeGridToBase64 } from '../utils/gridCodec';
import { createProjectThumbnail } from '../utils/projectThumbnail';
import type { MappedPixel } from '../utils/pixelation';
import type { ProjectDetail, ProjectSettings, ProjectSource, ProjectStatus } from '../types/project';

interface SaveProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 非空表示「更新已有作品」，为空表示「新建作品」 */
  projectId: string | null;
  /** 打开已有作品时带过来的原始信息，作为表单默认值 */
  initialTitle?: string;
  initialDescription?: string;
  initialTags?: string[];
  initialStatus?: ProjectStatus;
  /** 已有作品的来源类型；更新时原样带回，避免被改写成 photo */
  initialSource?: ProjectSource;
  /** 本次保存实际使用的来源类型（优先于 initialSource，用于「导入拼豆图纸」链路） */
  source?: ProjectSource;
  originalImageSrc: string | null;
  /** 导入的拼豆图纸原图；与 originalImageSrc 是两种不同的图片类型 */
  blueprintImageSrc?: string | null;
  mappedPixelData: MappedPixel[][] | null;
  colorCounts: { [key: string]: { count: number; color: string } } | null;
  totalBeadCount: number;
  settings: ProjectSettings;
  /**
   * 打开已有作品后原图没有被替换过。为 true 时更新请求不再重复上传原图，
   * 省掉一次几 MB 的无效上行。
   */
  originalImageUnchanged?: boolean;
  /** 同上，针对拼豆图纸原图 */
  blueprintImageUnchanged?: boolean;
  onSaved: (project: ProjectDetail) => void;
}

type Stage = 'idle' | 'encoding' | 'thumbnail' | 'uploading';

const STAGE_TEXT: Record<Exclude<Stage, 'idle'>, string> = {
  encoding: '正在压缩像素网格…',
  thumbnail: '正在生成预览图…',
  uploading: '正在上传到云端…',
};

const MAX_TAGS = 20;

export default function SaveProjectModal({
  isOpen,
  onClose,
  projectId,
  initialTitle,
  initialDescription,
  initialTags,
  initialStatus,
  initialSource,
  source,
  originalImageSrc,
  blueprintImageSrc,
  mappedPixelData,
  colorCounts,
  totalBeadCount,
  settings,
  originalImageUnchanged,
  blueprintImageUnchanged,
  onSaved,
}: SaveProjectModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);

  // 每次打开都按当前作品重置表单
  useEffect(() => {
    if (!isOpen) return;
    setTitle(initialTitle || '');
    setDescription(initialDescription || '');
    setTagsInput((initialTags ?? []).join(', '));
    setStage('idle');
    setError(null);
  }, [isOpen, initialTitle, initialDescription, initialTags]);

  const gridCellCount = useMemo(() => {
    if (!mappedPixelData || mappedPixelData.length === 0) return 0;
    return mappedPixelData.length * (mappedPixelData[0]?.length ?? 0);
  }, [mappedPixelData]);

  if (!isOpen) return null;

  const isBusy = stage !== 'idle';
  const isUpdate = Boolean(projectId);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isBusy) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('请填写作品名称');
      return;
    }
    if (!mappedPixelData || gridCellCount === 0) {
      setError('当前没有可保存的像素网格');
      return;
    }

    setError(null);
    try {
      setStage('encoding');
      const { data: gridData } = encodeGridToBase64(mappedPixelData);

      setStage('thumbnail');
      const thumbnail = await createProjectThumbnail(mappedPixelData);

      const images: { original?: string | null; thumbnail?: string | null; blueprint?: string | null } = {};
      // 更新已有作品且原图没换过时不再重复上传，省一次几 MB 的上行
      if (!(isUpdate && originalImageUnchanged)) {
        if (originalImageSrc) images.original = originalImageSrc;
      }
      if (!(isUpdate && blueprintImageUnchanged)) {
        if (blueprintImageSrc) images.blueprint = blueprintImageSrc;
      }
      if (thumbnail) images.thumbnail = thumbnail;

      const tags = tagsInput
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, MAX_TAGS);

      setStage('uploading');
      const payload = {
        title: trimmedTitle,
        description: description.trim(),
        tags,
        source: source ?? initialSource ?? 'photo',
        color_system: settings.color_system,
        settings,
        stats: { color_counts: colorCounts ?? {}, total_beads: totalBeadCount },
        // 制作状态已改由豆仓的「完成 x 次」表达（见 /works 页），
        // 这里原样带回既有值，仅保留字段兼容，不再让用户选择。
        status: initialStatus ?? 'unfinished',
        grid: gridData,
        images,
      };

      const project = isUpdate && projectId ? await updateProject(projectId, payload) : await createProject(payload);
      setStage('idle');
      onSaved(project);
      onClose();
    } catch (err) {
      setStage('idle');
      if (err instanceof ApiRequestError) {
        setError(err.message || '保存失败');
      } else if (err instanceof Error) {
        setError(`保存失败：${err.message}`);
      } else {
        setError('保存失败，请稍后再试');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base sm:text-lg font-semibold">{isUpdate ? '更新作品' : '保存到云端'}</h2>
          <button
            onClick={onClose}
            disabled={isBusy}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-40 text-xl leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label htmlFor="project-title" className="block text-sm font-medium mb-1">
              作品名称
            </label>
            <input
              id="project-title"
              type="text"
              value={title}
              maxLength={100}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：小狗挂件"
            />
          </div>

          <div>
            <label htmlFor="project-description" className="block text-sm font-medium mb-1">
              备注<span className="text-gray-400 font-normal">（可选）</span>
            </label>
            <textarea
              id="project-description"
              value={description}
              maxLength={500}
              rows={2}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="想做多大、用哪种豆子…"
            />
          </div>

          <div>
            <label htmlFor="project-tags" className="block text-sm font-medium mb-1">
              标签<span className="text-gray-400 font-normal">（可选，逗号分隔）</span>
            </label>
            <input
              id="project-tags"
              type="text"
              value={tagsInput}
              onChange={(event) => setTagsInput(event.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="挂件, 卡通"
            />
          </div>

          <div className="text-[11px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50 rounded-lg px-3 py-2 space-y-0.5">
            <div>
              网格：{mappedPixelData?.[0]?.length ?? 0} × {mappedPixelData?.length ?? 0} 格（{gridCellCount} 个格子）
            </div>
            <div>颜色：{Object.keys(colorCounts ?? {}).length} 种 · 共 {totalBeadCount} 颗</div>
          </div>

          {isBusy && <div className="text-xs sm:text-sm text-blue-600 dark:text-blue-400">{STAGE_TEXT[stage]}</div>}

          {error && (
            <div className="text-xs sm:text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 whitespace-pre-wrap">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="flex-1 py-2.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isBusy}
              className="flex-1 py-2.5 text-sm rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBusy ? '保存中…' : isUpdate ? '更新作品' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
