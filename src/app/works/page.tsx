'use client';

// 我的作品。/works
//
// 静态导出（output: "export"）下所有页面都是预渲染的，所以这里不做服务端鉴权，
// 而是在浏览器里调 /api/auth/me 判断登录态；接口本身对未登录请求一律 401。

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/AuthProvider';
import { ApiRequestError, deleteProject as deleteProjectRequest, getQuota, listProjects } from '../../utils/apiClient';
import { formatBytes } from '../../utils/formatBytes';
import type { ProjectSummary, QuotaStatus } from '../../types/project';

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

export default function WorksPage() {
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

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

  // 等登录态确定后再拉列表，避免未登录时白跑一次 401
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      setProjects([]);
      setQuota(null);
      return;
    }
    void reload();
    void loadQuota();
  }, [authLoading, user, reload, loadQuota]);

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
            {projects.map((project) => (
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
                    <span
                      className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full ${
                        project.status === 'finished'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                      }`}
                    >
                      {project.status === 'finished' ? '已完成' : '未完成'}
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
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
