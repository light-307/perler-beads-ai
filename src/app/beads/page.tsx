'use client';

// 我的豆仓。/beads
//
// 和 /works 一样：静态导出（output: "export"）下所有页面都是预渲染的，
// 这里不做服务端鉴权，而是在浏览器里调 /api/auth/me 判断登录态。
//
// 库存本身全部存云端（KV，按账号隔离），所以换设备看到的是同一份豆仓。
// 页面上的"库存数量"永远由该色号的记录 delta 求和算出，不做本地余额缓存。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/AuthProvider';
import {
  ApiRequestError,
  addBeadManualRecord,
  deleteBeadRecord,
  getBeadInventory,
  initializeBeadInventory,
} from '../../utils/apiClient';
import {
  compareColorCodes,
  describeRecord,
  formatBeadTime,
  getDefaultColorCodes,
  getHexByCode,
  stockOf,
  totalStock,
} from '../../utils/beadInventory';
import { colorSystemOptions, type ColorSystem } from '../../utils/colorSystemUtils';
import type { BeadInventory, BeadRecord } from '../../types/bead';

/** 初始化弹窗里的初始粒数快捷选项 */
const QUANTITY_OPTIONS = [100, 500, 1000];
/** 手动增减弹窗里的快捷输入值 */
const QUICK_DELTAS = [100, 1000, -100, -1000];

type SortMode = 'code' | 'stock';
type ScopeMode = 'default' | 'all';

/** 取色号的字母前缀（A01 → A，ZG03 → ZG），用于按字母筛选。 */
function letterOf(code: string): string {
  const match = code.match(/^[A-Za-z]+/);
  return match ? match[0].toUpperCase() : '#';
}

/** 某个色号系统的全部色号（291 个），用于"全部色号"初始化。 */
function fullColorCodes(system: ColorSystem): string[] {
  return Array.from(getHexByCode(system).keys()).sort(compareColorCodes);
}

function formatDelta(delta: number): string {
  return `${delta > 0 ? '+' : '-'}${Math.abs(delta)}`;
}

const RECORD_TYPE_LABEL: Record<BeadRecord['type'], string> = {
  init: '初始化',
  manual: '手动',
  work: '作品',
};

export default function BeadsPage() {
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();

  const [inventory, setInventory] = useState<BeadInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const [sortMode, setSortMode] = useState<SortMode>('code');
  const [query, setQuery] = useState('');
  const [letterFilter, setLetterFilter] = useState('');
  const [recordBusyId, setRecordBusyId] = useState<string | null>(null);

  // 初始化弹窗
  const [initOpen, setInitOpen] = useState(false);
  const [initSystem, setInitSystem] = useState<ColorSystem>('MARD');
  const [initScope, setInitScope] = useState<ScopeMode>('default');
  const [initQuantity, setInitQuantity] = useState('1000');
  const [initSubmitting, setInitSubmitting] = useState(false);

  // 色号明细弹窗（只读的操作记录 + 删除）
  const [detailCode, setDetailCode] = useState<string | null>(null);
  const [confirmRecordId, setConfirmRecordId] = useState<string | null>(null);

  // 手动增减库存弹窗
  const [adjustCode, setAdjustCode] = useState<string | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getBeadInventory();
      setInventory(data);
      // 还没初始化过：进页面就弹初始化弹窗（需求 2）
      if (!data || !data.initialized) setInitOpen(true);
    } catch (err) {
      if (err instanceof ApiRequestError && err.isUnauthorized) {
        setInventory(null);
      } else {
        setError(err instanceof ApiRequestError ? err.message || '加载失败' : '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // 等登录态确定后再拉数据，避免未登录时白跑一次 401
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      setInventory(null);
      return;
    }
    void reload();
  }, [authLoading, user, reload]);

  const system: ColorSystem = inventory?.color_system ?? initSystem;

  const hexMap = useMemo(() => getHexByCode(system), [system]);

  const initCodes = useMemo(
    () => (initScope === 'default' ? getDefaultColorCodes(initSystem) : fullColorCodes(initSystem)),
    [initScope, initSystem]
  );

  /** 库存里实际出现过的字母前缀，用于按字母筛选。 */
  const letterOptions = useMemo(() => {
    const letters = new Set<string>();
    for (const code of Object.keys(inventory?.colors ?? {})) letters.add(letterOf(code));
    return Array.from(letters).sort((a, b) => a.localeCompare(b, 'en'));
  }, [inventory]);

  const rows = useMemo(() => {
    const list = Object.values(inventory?.colors ?? {}).map((stock) => ({
      code: stock.code,
      stock: stockOf(inventory, stock.code),
    }));
    const keyword = query.trim().toUpperCase();
    const filtered = list.filter((row) => {
      if (letterFilter && letterOf(row.code) !== letterFilter) return false;
      if (keyword && !row.code.toUpperCase().includes(keyword)) return false;
      return true;
    });
    if (sortMode === 'stock') {
      // 由少到多；数量相同时按色号，保证顺序稳定
      return filtered.sort((a, b) => a.stock - b.stock || compareColorCodes(a.code, b.code));
    }
    return filtered.sort((a, b) => compareColorCodes(a.code, b.code));
  }, [inventory, query, sortMode, letterFilter]);

  const detailRecords = useMemo(() => {
    if (!detailCode) return [] as BeadRecord[];
    const records = inventory?.colors?.[detailCode]?.records ?? [];
    // 最近的操作排在最上面
    return [...records].sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
  }, [inventory, detailCode]);

  const handleLogout = async () => {
    await logout();
    router.replace('/');
  };

  /** 打开某个色号的手动增减弹窗。 */
  const openAdjust = (code: string) => {
    setAdjustCode(code);
    setAdjustDelta('');
    setAdjustNote('');
    setAdjustError(null);
  };

  /** 提交一次手动增减，成功后就地刷新该色号库存。 */
  const handleAdjustSubmit = async () => {
    if (!adjustCode) return;
    const value = Number(adjustDelta);
    if (!Number.isInteger(value) || value === 0) {
      setAdjustError('请输入非 0 的整数：正数入库，负数出库');
      return;
    }
    setAdjustSubmitting(true);
    setAdjustError(null);
    try {
      const note = adjustNote.trim();
      setInventory(await addBeadManualRecord({ color_code: adjustCode, delta: value, ...(note ? { note } : {}) }));
      setAdjustCode(null);
      setAdjustDelta('');
      setAdjustNote('');
    } catch (err) {
      setAdjustError(err instanceof ApiRequestError ? err.message || '调整失败' : '调整失败');
    } finally {
      setAdjustSubmitting(false);
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    setRecordBusyId(recordId);
    setError(null);
    try {
      setInventory(await deleteBeadRecord(recordId));
      setConfirmRecordId(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message || '删除失败' : '删除失败');
    } finally {
      setRecordBusyId(null);
    }
  };

  const handleInit = async () => {
    const quantity = Number(initQuantity);
    if (!Number.isInteger(quantity) || quantity < 0) {
      setError('初始粒数请填 0 或正整数');
      return;
    }
    setInitSubmitting(true);
    setError(null);
    try {
      const next = await initializeBeadInventory({
        color_system: initSystem,
        default_quantity: quantity,
        colors: initCodes,
      });
      setInventory(next);
      setInitOpen(false);
      setSortMode('code');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message || '初始化失败' : '初始化失败');
    } finally {
      setInitSubmitting(false);
    }
  };

  const openDetail = (code: string) => {
    setDetailCode(code);
    setConfirmRecordId(null);
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
        <p className="text-sm text-gray-500 dark:text-gray-400">登录后才能查看和管理你的豆仓库存。</p>
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

  const colorCount = Object.keys(inventory?.colors ?? {}).length;
  const beadTotal = totalStock(inventory);
  const initialized = Boolean(inventory?.initialized);

  return (
    <div className="min-h-screen p-4 sm:p-6 font-[family-name:var(--font-geist-sans)]">
      <div className="max-w-5xl mx-auto">
        <header className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold">我的豆仓</h1>
            <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {user.nickname || user.username} · {initialized ? `${colorCount} 个色号 · 合计 ${beadTotal} 粒` : '尚未初始化'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/works"
              className="px-4 py-2 text-xs sm:text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
            >
              我的作品
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

        {loading ? (
          <div className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">加载中…</div>
        ) : !initialized ? (
          <div className="py-16 text-center space-y-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">还没有初始化豆仓。</p>
            <button
              onClick={() => setInitOpen(true)}
              className="px-5 py-2 text-sm rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white shadow-md transition-all"
            >
              初始化豆仓
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] sm:text-xs text-gray-600 dark:text-gray-300">
              <span>
                色号系统 <span className="font-medium">{inventory?.color_system}</span>
              </span>
              <span>
                色号 <span className="font-medium">{colorCount}</span> 个
              </span>
              <span>
                合计 <span className="font-medium">{beadTotal}</span> 粒
              </span>
              <span className="text-gray-400 dark:text-gray-500">
                更新于 {formatBeadTime(inventory?.updated_at ?? '', mounted)}
              </span>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">排序</span>
                <button
                  onClick={() => setSortMode('code')}
                  className={`px-3 py-1.5 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                    sortMode === 'code'
                      ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                      : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  按色号
                </button>
                <button
                  onClick={() => setSortMode('stock')}
                  className={`px-3 py-1.5 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                    sortMode === 'stock'
                      ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                      : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  库存从少到多
                </button>
              </div>

              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索色号"
                className="ml-auto w-32 sm:w-40 px-3 py-1.5 text-[11px] sm:text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mr-0.5">字母</span>
              <button
                onClick={() => setLetterFilter('')}
                className={`px-2.5 py-1 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                  letterFilter === ''
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                    : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                全部
              </button>
              {letterOptions.map((letter) => (
                <button
                  key={letter}
                  onClick={() => setLetterFilter(letterFilter === letter ? '' : letter)}
                  className={`px-2.5 py-1 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                    letterFilter === letter
                      ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                      : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  {letter}
                </button>
              ))}
              <span className="ml-1 text-[11px] sm:text-xs text-gray-400 dark:text-gray-500">
                共 {rows.length} 个色号
              </span>
            </div>

            {rows.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">没有匹配的色号。</div>
            ) : (
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {rows.map((row) => (
                  <div
                    key={row.code}
                    className="flex flex-col gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 shadow-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="w-5 h-5 shrink-0 rounded border border-black/10 dark:border-white/20"
                        style={{ backgroundColor: hexMap.get(row.code) ?? '#ffffff' }}
                      />
                      <span className="text-sm font-medium break-all">{row.code}</span>
                      <span
                        className={`ml-auto text-sm font-semibold tabular-nums ${
                          row.stock < 0 ? 'text-red-600 dark:text-red-400' : ''
                        }`}
                      >
                        {row.stock}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => openAdjust(row.code)}
                        className="flex-1 text-[11px] px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 whitespace-nowrap"
                      >
                        手动增减
                      </button>
                      <button
                        onClick={() => openDetail(row.code)}
                        className="flex-1 text-[11px] px-2 py-1 rounded border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                      >
                        明细
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------------------------------------------------------- 初始化弹窗 */}
      {initOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-800 shadow-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base sm:text-lg font-bold">初始化豆仓</h2>
                <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  选择色号系统与每个色号的初始粒数，之后可以随时手动增减。
                </p>
              </div>
              {initialized && (
                <button
                  onClick={() => setInitOpen(false)}
                  className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
                  aria-label="关闭"
                >
                  ×
                </button>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-[11px] sm:text-xs font-medium text-gray-600 dark:text-gray-300">色号系统</p>
              <div className="flex flex-wrap gap-1.5">
                {colorSystemOptions.map((option) => (
                  <button
                    key={option.key}
                    onClick={() => setInitSystem(option.key as ColorSystem)}
                    className={`px-3 py-1.5 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                      initSystem === option.key
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                        : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-[11px] sm:text-xs font-medium text-gray-600 dark:text-gray-300">色号范围</p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setInitScope('default')}
                  className={`px-3 py-1.5 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                    initScope === 'default'
                      ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                      : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  默认色板（{getDefaultColorCodes(initSystem).length} 色）
                </button>
                <button
                  onClick={() => setInitScope('all')}
                  className={`px-3 py-1.5 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                    initScope === 'all'
                      ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                      : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  全部色号（{fullColorCodes(initSystem).length} 色）
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-[11px] sm:text-xs font-medium text-gray-600 dark:text-gray-300">每个色号初始粒数</p>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  value={initQuantity}
                  onChange={(event) => setInitQuantity(event.target.value)}
                  className="w-28 px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {QUANTITY_OPTIONS.map((value) => (
                  <button
                    key={value}
                    onClick={() => setInitQuantity(String(value))}
                    className={`px-3 py-1.5 text-[11px] sm:text-xs rounded-lg border transition-colors ${
                      initQuantity === String(value)
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                        : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 rounded-lg px-3 py-2">
              将创建 <span className="font-medium">{initCodes.length}</span> 个色号，
              共 <span className="font-medium">{initCodes.length * (Number(initQuantity) || 0)}</span> 粒。
              每个色号都会生成一条「初始化」记录，方便日后追溯。
            </p>

            <div className="flex items-center justify-end gap-2 pt-1">
              {initialized && (
                <button
                  onClick={() => setInitOpen(false)}
                  className="px-4 py-2 text-xs sm:text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  取消
                </button>
              )}
              <button
                onClick={() => void handleInit()}
                disabled={initSubmitting || initCodes.length === 0}
                className="px-4 py-2 text-xs sm:text-sm rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white shadow-md disabled:opacity-50 transition-all"
              >
                {initSubmitting ? '初始化中…' : '确认初始化'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- 色号明细弹窗 */}
      {detailCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-gray-800 shadow-xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
              <span
                className="w-5 h-5 shrink-0 rounded border border-black/10 dark:border-white/20"
                style={{ backgroundColor: hexMap.get(detailCode) ?? '#ffffff' }}
              />
              <h2 className="text-base font-bold break-all">{detailCode}</h2>
              <span className="ml-auto text-sm">
                当前库存{' '}
                <span
                  className={`font-semibold tabular-nums ${
                    stockOf(inventory, detailCode) < 0 ? 'text-red-600 dark:text-red-400' : ''
                  }`}
                >
                  {stockOf(inventory, detailCode)}
                </span>{' '}
                粒
              </span>
              <button
                onClick={() => setDetailCode(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-2">
              {detailRecords.length === 0 ? (
                <p className="py-8 text-center text-xs text-gray-500 dark:text-gray-400">这个色号还没有任何操作记录。</p>
              ) : (
                detailRecords.map((record) => (
                  <div
                    key={record.id}
                    className="flex items-start gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          {RECORD_TYPE_LABEL[record.type] ?? record.type}
                        </span>
                        <span
                          className={`text-xs font-semibold tabular-nums ${
                            record.delta < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                          }`}
                        >
                          {formatDelta(record.delta)} 粒
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] sm:text-xs text-gray-600 dark:text-gray-300 break-words">
                        {describeRecord(record)}
                        {record.note && record.type === 'manual' ? `（${record.note}）` : ''}
                      </p>
                      <p className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
                        {formatBeadTime(record.at, mounted)}
                      </p>
                    </div>
                    {confirmRecordId === record.id ? (
                      <div className="shrink-0 flex items-center gap-1">
                        <button
                          onClick={() => void handleDeleteRecord(record.id)}
                          disabled={recordBusyId === record.id}
                          className="text-[10px] px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {recordBusyId === record.id ? '删除中…' : '确认删除'}
                        </button>
                        <button
                          onClick={() => setConfirmRecordId(null)}
                          className="text-[10px] px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmRecordId(record.id)}
                        className="shrink-0 text-[10px] px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-red-50 hover:text-red-600 hover:border-red-300 dark:hover:bg-red-900/20 transition-colors"
                      >
                        删除
                      </button>
                    )}
                  </div>
                ))
              )}
              <p className="pt-1 text-[10px] text-gray-400 dark:text-gray-500">
                删除记录后，该色号的库存会自动变成「没有这条操作」时的数量。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- 手动增减弹窗 */}
      {adjustCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 shadow-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <span
                className="w-5 h-5 shrink-0 rounded border border-black/10 dark:border-white/20"
                style={{ backgroundColor: hexMap.get(adjustCode) ?? '#ffffff' }}
              />
              <h2 className="text-base font-bold break-all">{adjustCode}</h2>
              <span className="ml-auto text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
                当前{' '}
                <span
                  className={`font-semibold tabular-nums ${
                    stockOf(inventory, adjustCode) < 0 ? 'text-red-600 dark:text-red-400' : ''
                  }`}
                >
                  {stockOf(inventory, adjustCode)}
                </span>{' '}
                粒
              </span>
              <button
                onClick={() => setAdjustCode(null)}
                className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
              正数入库、负数出库，提交后会生成一条「手动」操作记录。
            </p>

            <div className="space-y-2">
              <input
                type="number"
                value={adjustDelta}
                onChange={(event) => {
                  setAdjustDelta(event.target.value);
                  setAdjustError(null);
                }}
                placeholder="例如 100 或 -50"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex flex-wrap gap-1.5">
                {QUICK_DELTAS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setAdjustDelta(String(value));
                      setAdjustError(null);
                    }}
                    className={`flex-1 min-w-[4.5rem] px-2 py-1.5 text-[11px] sm:text-xs rounded-lg border tabular-nums transition-colors ${
                      adjustDelta.trim() === String(value)
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-600'
                        : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    {value > 0 ? `+${value}` : value}
                  </button>
                ))}
              </div>
              <input
                value={adjustNote}
                onChange={(event) => setAdjustNote(event.target.value)}
                placeholder="备注（可空）"
                maxLength={200}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {adjustError && (
              <div className="text-[11px] sm:text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
                {adjustError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setAdjustCode(null)}
                disabled={adjustSubmitting}
                className="px-4 py-2 text-xs sm:text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void handleAdjustSubmit()}
                disabled={adjustSubmitting}
                className="px-4 py-2 text-xs sm:text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                {adjustSubmitting ? '提交中…' : '提交'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
