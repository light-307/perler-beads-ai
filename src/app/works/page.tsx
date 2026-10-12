'use client';

// 我的作品。/works
//
// 静态导出（output: "export"）下所有页面都是预渲染的，所以这里不做服务端鉴权，
// 而是在浏览器里调 /api/auth/me 判断登录态；接口本身对未登录请求一律 401。
//
// 每个作品的「完成 1 次 / 取消 1 次」直接操作豆仓库存（见 functions/api/beads/**）：
// - 完成后作品名右侧显示「完成 x 次」，没完成过显示「未完成」；
// - 完成次数由豆仓里该作品的 work 记录分组数算出来，不再读作品自身的 status 字段。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/AuthProvider';
import {
  ApiRequestError,
  cancelBeadWork,
  completeBeadWork,
  deleteProject as deleteProjectRequest,
  getBeadInventory,
  getProject,
  getQuota,
  listProjects,
} from '../../utils/apiClient';
import { buildCompletionCounts, mapHexCountsToConsumeLines, stockOf } from '../../utils/beadInventory';
import { formatBytes } from '../../utils/formatBytes';
import type { ProjectSummary, QuotaStatus } from '../../types/project';
import type { BeadConsumeLine, BeadInventory } from '../../types/bead';

function formatTime(iso: string, useLocal: boolean): string {
  if (!iso) return '';
  if (!useLocal) {
    // 预渲染阶段用一个与语言环境无关的写法，避免服务端/客户端水合结果不一致
    return iso.slice(0, 16).replace('T', ' ');
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace('T', ' ');
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 库存不足时弹确认框用到的明细 */
interface ShortageState {
  project: ProjectSummary;
  lines: BeadConsumeLine[];
  missing: { code: string; need: number; stock: number }[];
}

export default function WorksPage() {
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  // 豆仓：完成次数与库存都以它为准
  const [inventory, setInventory] = useState<BeadInventory | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [shortage, setShortage] = useState<ShortageState | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (err) {
      if (err instanceof ApiRequestError && err.isUnauthorized) {
        setProjects([]);
      } else if (err instanceof ApiRequestError) {
        setError(err.message || '加载失败');
      } else {
        setError('加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // 云端用量只是附加信息：接口挂掉或没配好时静默隐藏，不能连累作品列表
  const loadQuota = useCallback(async () => {
    try {
      setQuota(await getQuota());
    } catch {
      setQuota(null);
    }
  }, []);

  // 豆仓同理：读不到就当"没有豆仓"，完成按钮会提示先去初始化
  const loadInventory = useCallback(async () => {
    try {
      setInventory(await getBeadInventory());
    } catch {
      setInventory(null);
    }
  }, []);

  // 等登录态确定后再拉列表，避免未登录时白跑一次 401
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      setProjects([]);
      setQuota(null);
      setInventory(null);
      return;
    }
    void reload();
    void loadQuota();
    void loadInventory();
  }, [authLoading, user, reload, loadQuota, loadInventory]);

  const completionCounts = useMemo(() => buildCompletionCounts(inventory), [inventory]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      await deleteProjectRequest(id);
      setProjects((prev) => prev.filter((item) => item.id !== id));
      setConfirmId(null);
      // 删除会释放存储，用量条要跟着回落
      await loadQuota();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message || '删除失败' : '删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  /** 真正提交一次完成：扣库存 + 写记录。 */
  const submitComplete = async (project: ProjectSummary, lines: BeadConsumeLine[]): Promise<boolean> => {
    setBusyId(project.id);
    setError(null);
    try {
      const result = await completeBeadWork({
        project_id: project.id,
        project_title: project.title,
        lines,
      });
      setInventory(result.inventory);
      const total = lines.reduce((sum, line) => sum + line.quantity, 0);
      setNotice(`《${project.title}》记完成 1 次，共扣减 ${total} 粒（涉及 ${lines.length} 个色号）。`);
      return true;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message || '记录完成失败' : '记录完成失败');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 「完成 1 次」。
   *
   * 每次都重新拉一次作品详情再算用量，保证按"当前作品所用的各色号数量"扣减
   * （需求 6：编辑修改并保存后，之后完成的消耗要按新用量算）。
   */
  const handleComplete = async (project: ProjectSummary) => {
    if (!inventory?.initialized) {
      setError('还没有初始化豆仓，请先到「我的豆仓」初始化后再记录完成。');
      return;
    }
    setBusyId(project.id);
    setError(null);
    setNotice(null);
    try {
      const detail = await getProject(project.id);
      const lines = mapHexCountsToConsumeLines(detail.stats?.color_counts, inventory.color_system);
      if (lines.length === 0) {
        setError('这个作品没有可扣减的颜色用量，请先在编辑器里生成图纸并保存。');
        return;
      }
      const missing = lines
        .map((line) => ({ code: line.color_code, need: line.quantity, stock: stockOf(inventory, line.color_code) }))
        .filter((item) => item.stock < item.need);
      if (missing.length > 0) {
        // 库存不足：弹确认框，用户确认后仍照常扣减（允许扣成负数）
        setShortage({ project, lines, missing });
        return;
      }
      await submitComplete(project, lines);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message || '读取作品数据失败' : '读取作品数据失败');
    } finally {
      setBusyId(null);
    }
  };

  /** 「取消 1 次」：撤销该作品最近一次完成。 */
  const handleCancel = async (project: ProjectSummary) => {
    if (!inventory?.initialized) {
      setError('还没有初始化豆仓，请先到「我的豆仓」初始化。');
      return;
    }
    setBusyId(project.id);
    setError(null);
    setNotice(null);
    try {
      const result = await cancelBeadWork(project.id);
      setInventory(result.inventory);
      if (!result.removed) {
        setError(`《${project.title}》没有可取消的完成记录。`);
      } else {
        setNotice(`已取消《${project.title}》最近一次完成，退回 ${result.removed.beads} 粒。`);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message || '取消完成失败' : '取消完成失败');
    } finally {
      setBusyId(null);
    }
  };

  /** 库存不足时用户选择"仍要完成"。 */
  const handleConfirmShortage = async () => {
    if (!shortage) return;
    const ok = await submitComplete(shortage.project, shortage.lines);
    if (ok) setShortage(null);
  };

  const handleLogout = async () => {
    await logout();
    router.replace('/');
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">加载中…</div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center font-[family-name:var(--font-geist-sans)]">
        <h1 className="text-xl font-bold">请先登录</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">登录后才能查看和管理云端保存的作品。</p>
        <div className="flex gap-3">
          <Link
            href="/login"
            className="px-5 py-2 text-sm rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white shadow-md transition-all"
          >
            去登录
          </Link>
          <Link
            href="/register"
            className="px-5 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
          >
            注册
          </Link>
        </div>
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          返回首页
        </Link>
      </div>
    );
  }

  const storageRatio =
    quota && quota.storage_limit_bytes > 0 ? quota.storage_bytes / quota.storage_limit_bytes : 0;
  const quotaNearLimit = storageRatio >= 0.9;

  return (
    <div className="min-h-screen p-4 sm:p-6 font-[family-name:var(--font-geist-sans)]">
      <div className="max-w-5xl mx-auto">
        <header className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold">我的作品</h1>
            <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {user.nickname || user.username} · 共 {projects.length} 件
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/beads"
              className="px-4 py-2 text-xs sm:text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
            >
              我的豆仓
            </Link>
            <Link
              href="/"
              className="px-4 py-2 text-xs sm:text-sm rounded-lg bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white shadow-md transition-all"
            >
              继续创作
            </Link>
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-xs sm:text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
            >
              退出登录
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-4 text-xs sm:text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {notice && (
          <div className="mb-4 text-xs sm:text-sm text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2">
            {notice}
          </div>
        )}

        {quota && (
          <div className="mb-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px] sm:text-xs text-gray-600 dark:text-gray-300">
              <span>
                云端存储 <span className="font-medium">{formatBytes(quota.storage_bytes)}</span> /{' '}
                {formatBytes(quota.storage_limit_bytes)}
              </span>
              <span className="text-gray-400 dark:text-gray-500">
                本月 R2 操作：Class A {quota.class_a_ops}/{quota.class_a_limit} · Class B {quota.class_b_ops}/
                {quota.class_b_limit}
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
              <div
                className={`h-full rounded-full transition-all ${
                  quotaNearLimit ? 'bg-red-500' : storageRatio >= 0.7 ? 'bg-amber-500' : 'bg-green-500'
                }`}
                style={{ width: `${Math.min(100, storageRatio * 100).toFixed(1)}%` }}
              />
            </div>
            {quotaNearLimit && (
              <p className="mt-1.5 text-[11px] sm:text-xs text-red-600 dark:text-red-400">
                存储接近上限，超出后无法再保存新作品，请先删除一些作品。
              </p>
            )}
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="py-16 text-center space-y-2">
            <p className="text-sm text-gray-500 dark:text-gray-400">还没有保存过作品。</p>
            <Link href="/" className="inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline">
              去首页生成一张，然后点「保存到云端」
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => {
              const completionCount = completionCounts[project.id] ?? 0;
              const rowBusy = busyId === project.id;
              return (
                <div
                  key={project.id}
                  className="flex flex-col bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden"
                >
                  <Link
                    href={`/?project=${encodeURIComponent(project.id)}`}
                    className="block bg-[repeating-conic-gradient(#e5e7eb_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] dark:bg-[repeating-conic-gradient(#374151_0%_25%,transparent_0%_50%)]"
                  >
                    {project.thumbnail_url ? (
                      // 缩略图接口需要登录 Cookie，用原生 img 即可；next/image 在
                      // output: "export" 下被强制 unoptimized，没有额外收益。
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={project.thumbnail_url}
                        alt={project.title}
                        className="w-full h-40 object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-40 flex items-center justify-center text-xs text-gray-400">暂无预览图</div>
                    )}
                  </Link>

                  <div className="flex-1 flex flex-col p-3 gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/?project=${encodeURIComponent(project.id)}`}
                        className="font-medium text-sm sm:text-base leading-snug hover:text-blue-600 dark:hover:text-blue-400 break-all"
                      >
                        {project.title}
                      </Link>
                      {/* 完成状态完全由豆仓里的完成次数决定（需求 5） */}
                      <span
                        className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full ${
                          completionCount > 0
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                        }`}
                      >
                        {completionCount > 0 ? `完成${completionCount}次` : '未完成'}
                      </span>
                    </div>

                    {project.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{project.description}</p>
                    )}

                    {project.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {project.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="mt-auto pt-1 text-[11px] text-gray-400 dark:text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
                      {project.grid && <span>{project.grid.N}×{project.grid.M} 格</span>}
                      {project.stats?.total_beads ? <span>{project.stats.total_beads} 颗</span> : null}
                      <span>{formatTime(project.updated_at, mounted)}</span>
                    </div>

                    {confirmId === project.id ? (
                      <div className="flex items-center gap-2 pt-1">
                        <span className="text-[11px] text-red-600 dark:text-red-400 flex-1">确认删除？不可恢复</span>
                        <button
                          onClick={() => handleDelete(project.id)}
                          disabled={deletingId === project.id}
                          className="text-[11px] px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {deletingId === project.id ? '删除中…' : '确认'}
                        </button>
                        <button
                          onClick={() => setConfirmId(null)}
                          className="text-[11px] px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 pt-1">
                          <Link
                            href={`/?project=${encodeURIComponent(project.id)}`}
                            className="flex-1 text-center text-[11px] px-2 py-1.5 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                          >
                            打开
                          </Link>
                          <button
                            onClick={() => setConfirmId(project.id)}
                            className="text-[11px] px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300 dark:hover:bg-red-900/20 transition-colors"
                          >
                            删除
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => void handleComplete(project)}
                            disabled={rowBusy}
                            title="按当前作品用量扣减豆仓库存，并记一次完成"
                            className="flex-1 text-[11px] px-2 py-1.5 rounded bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
                          >
                            {rowBusy ? '处理中…' : '完成1次'}
                          </button>
                          <button
                            onClick={() => void handleCancel(project)}
                            disabled={rowBusy || completionCount === 0}
                            title={completionCount === 0 ? '还没有完成记录' : '撤销最近一次完成，退回库存'}
                            className="flex-1 text-[11px] px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            取消1次
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------- 库存不足确认弹窗 */}
      {shortage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-800 shadow-xl p-5 space-y-3">
            <h2 className="text-base sm:text-lg font-bold">豆仓库存不足</h2>
            <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
              《{shortage.project.title}》有 {shortage.missing.length} 个色号的库存不够。继续完成会照常扣减，
              这些色号的库存会变成负数。
            </p>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
              {shortage.missing.map((item) => (
                <div key={item.code} className="flex items-center gap-3 px-3 py-1.5 text-[11px] sm:text-xs">
                  <span className="font-medium break-all">{item.code}</span>
                  <span className="ml-auto text-gray-500 dark:text-gray-400 tabular-nums">需要 {item.need}</span>
                  <span className="text-gray-500 dark:text-gray-400 tabular-nums">现有 {item.stock}</span>
                  <span className="text-red-600 dark:text-red-400 tabular-nums">缺 {item.need - item.stock}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setShortage(null)}
                className="px-4 py-2 text-xs sm:text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                先不完成
              </button>
              <button
                onClick={() => void handleConfirmShortage()}
                disabled={busyId === shortage.project.id}
                className="px-4 py-2 text-xs sm:text-sm rounded-lg bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
              >
                {busyId === shortage.project.id ? '处理中…' : '仍要完成'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
