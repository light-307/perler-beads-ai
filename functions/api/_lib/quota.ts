// R2 用量配额：对象存储总量 + Class A / Class B 操作次数。
//
// 为什么要自己记账：R2 没有"查询当前用量"的接口（只有控制台面板能看到），
// 而免费额度是 10GB 存储 / 100 万次 Class A / 1000 万次 Class B。
// 本项目按免费额度的**十分之一**自我约束（1 GiB / 10 万次 / 100 万次），
// 超过就拒绝写入，避免某次批量保存把用量顶到计费区间。
//
// 记账数据与作品元数据放在同一个 KV 命名空间：
//   quota:r2:bytes       → 当前存储总字节数（十进制字符串）
//   quota:r2:ops:YYYY-MM → 本月操作次数，形如 {"a":12,"b":34}
//
// 两个已知的精度限制（个人自用规模下可接受，且都只会"少记"）：
// 1. KV 没有原子自增，同一 isolate 内并发请求可能丢掉个别计数；
// 2. 存储总量按"读到的当前值 + 本次新增"判断，两个请求同时通过检查时
//    最多超出几十 KB～几 MB。要做到绝对精确需要引入 D1 或 Durable Object，
//    对这个项目不值得。
//
// 所有 R2 访问都必须走本文件导出的 r2* 包装函数，否则不会被计数，
// 配额也就形同虚设。

import { ApiError } from './http';
import type { Env, KVNamespaceBinding, R2ObjectBody } from './env';
import { getKV, getR2 } from './store';
// 与服务端报错文案、前端用量面板共用同一份实现
import { formatBytes } from '../../../src/utils/formatBytes';
import type { QuotaStatus } from '../../../src/types/project';

export { formatBytes };
export type { QuotaStatus };

/** 默认存储总量上限：1 GiB（免费额度 10GB 的十分之一） */
export const DEFAULT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
/** 默认 Class A（写入 / 列举 / 删除）每月上限：10 万次（免费额度 100 万次的十分之一） */
export const DEFAULT_CLASS_A_LIMIT = 100_000;
/** 默认 Class B（读取）每月上限：100 万次（免费额度 1000 万次的十分之一） */
export const DEFAULT_CLASS_B_LIMIT = 1_000_000;

const STORAGE_KEY = 'quota:r2:bytes';
const OP_KEY_PREFIX = 'quota:r2:ops:';
const opKey = (month: string) => `${OP_KEY_PREFIX}${month}`;

export type R2OpClass = 'a' | 'b';

export interface QuotaLimits {
  storageBytes: number;
  classA: number;
  classB: number;
}

// ---------------------------------------------------------------- 基础工具

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** 读取生效的上限：环境变量优先，缺省用代码里的默认值。 */
export function getQuotaLimits(env: Env): QuotaLimits {
  return {
    storageBytes: positiveInt(env.R2_STORAGE_LIMIT_BYTES, DEFAULT_STORAGE_LIMIT_BYTES),
    classA: positiveInt(env.R2_CLASS_A_LIMIT, DEFAULT_CLASS_A_LIMIT),
    classB: positiveInt(env.R2_CLASS_B_LIMIT, DEFAULT_CLASS_B_LIMIT),
  };
}

export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function nextMonthStart(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** 从一条作品元数据里取出它占用的字节数。 */
export function projectStoredBytes(meta: { bytes?: unknown; file_bytes?: unknown } | null | undefined): number {
  const total = Number(meta?.bytes);
  if (Number.isFinite(total) && total >= 0) return Math.floor(total);
  // 兼容没有 bytes 字段的旧记录：按每个对象的字节数求和
  const map = meta?.file_bytes;
  if (map && typeof map === 'object') {
    let sum = 0;
    for (const value of Object.values(map as Record<string, unknown>)) {
      const size = Number(value);
      if (Number.isFinite(size) && size > 0) sum += Math.floor(size);
    }
    return sum;
  }
  return 0;
}

// ---------------------------------------------------------------- 存储总量

/** 遍历所有作品元数据重算存储总量（计数丢失或首次运行时的自愈路径）。 */
async function recomputeStoredBytes(env: Env): Promise<number> {
  const namespace = getKV(env);
  let total = 0;
  let cursor: string | undefined;

  // proj: 前缀跨越所有用户：R2 桶是全局共享的，配额也必须按桶算
  for (let page = 0; page < 20; page += 1) {
    const result = await namespace.list({ prefix: 'proj:', cursor, limit: 1000 });
    const values = await Promise.all(result.keys.map((item) => namespace.get(item.name, 'text')));
    for (const raw of values) {
      if (!raw) continue;
      try {
        total += projectStoredBytes(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // 坏记录跳过，不影响整体统计
      }
    }
    if (result.list_complete || !result.cursor) break;
    cursor = result.cursor;
  }
  return total;
}

/** 读当前存储总量；计数键不存在时按作品元数据重算并落盘。 */
export async function readStoredBytes(env: Env): Promise<number> {
  const namespace = getKV(env);
  const raw = await namespace.get(STORAGE_KEY, 'text');
  if (raw !== null && raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  const recomputed = await recomputeStoredBytes(env);
  await namespace.put(STORAGE_KEY, String(recomputed));
  return recomputed;
}

/**
 * 写入前的配额检查。additionalBytes 为本次要新增的净字节数，
 * 小于等于 0（覆盖更小的文件、删除）一律放行。
 */
export async function ensureStorageAvailable(env: Env, additionalBytes: number): Promise<void> {
  if (!Number.isFinite(additionalBytes) || additionalBytes <= 0) return;

  const limits = getQuotaLimits(env);
  const used = await readStoredBytes(env);
  if (used + additionalBytes > limits.storageBytes) {
    throw new ApiError(
      507,
      'STORAGE_QUOTA_EXCEEDED',
      `云端存储已用 ${formatBytes(used)}，本次还要写入 ${formatBytes(additionalBytes)}，` +
        `超过自设上限 ${formatBytes(limits.storageBytes)}。请先删除一些作品再保存` +
        `（确实需要更多空间时，可调高环境变量 R2_STORAGE_LIMIT_BYTES 后重新部署）。`
    );
  }
}

/** 写入成功后累加存储计数；deltaBytes 可以为负（删除 / 覆盖成更小的文件）。 */
export async function commitStorageDelta(env: Env, deltaBytes: number): Promise<void> {
  if (!Number.isFinite(deltaBytes) || deltaBytes === 0) return;
  const namespace = getKV(env);
  const current = await readStoredBytes(env);
  // 兜底夹到 0：宁可少记也不能记成负数，否则后面的检查会误放行
  await namespace.put(STORAGE_KEY, String(Math.max(0, Math.round(current + deltaBytes))));
}

// ---------------------------------------------------------------- 操作计数

interface OpCounter {
  month: string;
  a: number;
  b: number;
  dirty: boolean;
}

/**
 * 计数缓存挂在 KV binding 上：一个 isolate 里 binding 只有一个对象，
 * 于是"一次请求无论做多少次 R2 操作，只读一次 KV、写一次 KV"。
 * 请求结束时由 flushR2Ops 落盘并清 dirty。
 */
let opCounters = new WeakMap<object, OpCounter>();

function counterKey(env: Env): object | null {
  const binding = env?.PB_KV;
  return binding ? (binding as unknown as object) : null;
}

async function persistCounter(namespace: KVNamespaceBinding, counter: OpCounter): Promise<void> {
  await namespace.put(opKey(counter.month), JSON.stringify({ a: counter.a, b: counter.b }));
  counter.dirty = false;
}

async function loadOpCounter(env: Env): Promise<OpCounter> {
  const namespace = getKV(env);
  const key = counterKey(env);
  const month = currentMonth();
  const cached = key ? opCounters.get(key) : undefined;
  if (cached && cached.month === month) return cached;

  // 跨月时先把上个月还没落盘的尾巴写掉，再开新账
  if (cached && cached.dirty) {
    try {
      await persistCounter(namespace, cached);
    } catch (error) {
      console.error('[quota] 结转上月 R2 操作计数失败:', error);
    }
  }

  const counter: OpCounter = { month, a: 0, b: 0, dirty: false };
  const raw = await namespace.get(opKey(month), 'text');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { a?: unknown; b?: unknown };
      const a = Number(parsed.a);
      const b = Number(parsed.b);
      counter.a = Number.isFinite(a) && a > 0 ? Math.floor(a) : 0;
      counter.b = Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
    } catch {
      // 坏数据当作 0 重新开始
    }
  }
  if (key) opCounters.set(key, counter);
  return counter;
}

/** 计数 + 限额检查。超限直接抛错，调用方不会再真正发起 R2 请求。 */
async function useR2Operation(env: Env, cls: R2OpClass): Promise<void> {
  const limits = getQuotaLimits(env);
  const counter = await loadOpCounter(env);
  const limit = cls === 'a' ? limits.classA : limits.classB;
  const used = cls === 'a' ? counter.a : counter.b;

  if (used + 1 > limit) {
    const variable = cls === 'a' ? 'R2_CLASS_A_LIMIT' : 'R2_CLASS_B_LIMIT';
    throw new ApiError(
      429,
      'R2_OPERATION_LIMIT_EXCEEDED',
      `本月 R2 Class ${cls.toUpperCase()} 操作已达自设上限 ${limit.toLocaleString('en-US')} 次（${counter.month}）。` +
        `计数会在 ${nextMonthStart()}（UTC）自动重置；` +
        `确实需要更多额度时，可调高环境变量 ${variable} 后重新部署。`
    );
  }

  if (cls === 'a') counter.a += 1;
  else counter.b += 1;
  counter.dirty = true;
}

/**
 * 把本次请求累计的操作次数写回 KV。
 * 在处理器里用 try/finally 调用；本身不抛错，记账失败不能影响正常响应。
 */
export async function flushR2Ops(env: Env): Promise<void> {
  const key = env ? counterKey(env) : null;
  const namespace = env?.PB_KV;
  if (!key || !namespace) return;
  const counter = opCounters.get(key);
  if (!counter || !counter.dirty) return;
  try {
    await persistCounter(namespace, counter);
  } catch (error) {
    console.error('[quota] 写入 R2 操作计数失败:', error);
  }
}

// ---------------------------------------------------------------- R2 包装
// 所有 R2 访问都必须经过这里，否则不会被计数。

export interface R2PutOptions {
  httpMetadata?: { contentType?: string; cacheControl?: string };
}

/** Class A：写入对象。 */
export async function r2PutObject(env: Env, key: string, value: Uint8Array, options?: R2PutOptions): Promise<void> {
  await useR2Operation(env, 'a');
  await getR2(env).put(key, value, options);
}

/** Class B：读取对象。 */
export async function r2GetObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  await useR2Operation(env, 'b');
  return getR2(env).get(key);
}

/** Class A：删除对象（一次调用不论删几个都记 1 次，与 R2 的宽松口径一致）。 */
export async function r2DeleteObjects(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await useR2Operation(env, 'a');
  await getR2(env).delete(keys);
}

/** Class A：列举对象。 */
export async function r2ListObjects(
  env: Env,
  prefix: string,
  limit = 1000
): Promise<{ objects: Array<{ key: string; size: number }>; truncated: boolean; cursor?: string }> {
  await useR2Operation(env, 'a');
  return getR2(env).list({ prefix, limit });
}

// ---------------------------------------------------------------- 状态查询

/** GET /api/quota 用：返回当前用量与上限。 */
export async function getQuotaStatus(env: Env): Promise<QuotaStatus> {
  const limits = getQuotaLimits(env);
  const namespace = getKV(env);
  const month = currentMonth();
  const storageBytes = await readStoredBytes(env);

  let classA = 0;
  let classB = 0;
  const key = counterKey(env);
  const cached = key ? opCounters.get(key) : undefined;
  if (cached && cached.month === month) {
    // 缓存里的值已经是"KV 里的值 + 本次请求尚未落盘的增量"
    classA = cached.a;
    classB = cached.b;
  } else {
    const raw = await namespace.get(opKey(month), 'text');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { a?: unknown; b?: unknown };
        const a = Number(parsed.a);
        const b = Number(parsed.b);
        classA = Number.isFinite(a) && a > 0 ? Math.floor(a) : 0;
        classB = Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
      } catch {
        // 坏数据当作 0
      }
    }
  }

  return {
    storage_bytes: storageBytes,
    storage_limit_bytes: limits.storageBytes,
    class_a_ops: classA,
    class_a_limit: limits.classA,
    class_b_ops: classB,
    class_b_limit: limits.classB,
    month,
    resets_at: nextMonthStart(),
  };
}

/** 仅供本地验证脚本使用：清掉 isolate 内的计数缓存（下一次操作会重新从 KV 读）。 */
export function resetQuotaCacheForTests(): void {
  opCounters = new WeakMap<object, OpCounter>();
}
