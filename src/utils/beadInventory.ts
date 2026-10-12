// 豆仓前端工具：色号列表、排序、库存计算、作品色量 → 豆仓色号的映射。
//
// 这里只做纯计算，不碰网络与 DOM，便于在页面里直接复用，也方便单独验证。
// 色号对应关系复用 `src/app/colorSystemMapping.json`（hex → 各系统色号），
// 与主编辑器的色板完全同源。

import colorSystemMapping from '../app/colorSystemMapping.json';
import type { ColorSystem } from './colorSystemUtils';
import type { BeadConsumeLine, BeadInventory, BeadRecord } from '../types/bead';

type ColorMapping = Record<string, Partial<Record<ColorSystem, string>>>;

const mapping = colorSystemMapping as ColorMapping;

/**
 * MARD 默认色板排除的系列前缀（与 `src/app/page.tsx` 的
 * DEFAULT_UNSELECTED_MARD_PREFIXES 保持一致）：291 色里的 221 色。
 */
const DEFAULT_UNSELECTED_MARD_PREFIXES = ['P', 'Q', 'R', 'T', 'Y', 'ZG'];

const defaultCodesCache = new Map<ColorSystem, string[]>();
const hexByCodeCache = new Map<ColorSystem, Map<string, string>>();

/**
 * 某个色号系统下的默认色号列表。
 *
 * 口径与编辑器默认色板一致：先按 MARD 码排除 P/Q/R/T/Y/ZG 系列，
 * 再把保留下来的 221 个颜色映射到目标系统。任何系统都得到 221 个色号。
 */
export function getDefaultColorCodes(system: ColorSystem): string[] {
  const cached = defaultCodesCache.get(system);
  if (cached) return cached;

  const codes = new Set<string>();
  for (const colorData of Object.values(mapping)) {
    const mardCode = colorData.MARD;
    if (!mardCode) continue;
    if (DEFAULT_UNSELECTED_MARD_PREFIXES.some((prefix) => mardCode.startsWith(prefix))) continue;
    const code = colorData[system];
    if (code) codes.add(code);
  }

  const list = Array.from(codes).sort(compareColorCodes);
  defaultCodesCache.set(system, list);
  return list;
}

/** 色号 → hex 的反查表（用于列表里的颜色小方块）。 */
export function getHexByCode(system: ColorSystem): Map<string, string> {
  const cached = hexByCodeCache.get(system);
  if (cached) return cached;

  const result = new Map<string, string>();
  for (const [hex, colorData] of Object.entries(mapping)) {
    const code = colorData[system];
    if (!code) continue;
    // 同一色号可能对应多个 hex（重复色），保留第一个
    if (!result.has(code)) result.set(code, hex.toUpperCase());
  }
  hexByCodeCache.set(system, result);
  return result;
}

/** 把 hex（#RRGGBB）换算成豆仓色号；该颜色不在色号系统里时返回 null。 */
export function hexToColorCode(hex: string, system: ColorSystem): string | null {
  const normalized = (hex ?? '').trim().toUpperCase();
  if (!normalized.startsWith('#')) return null;
  return mapping[normalized]?.[system] ?? null;
}

/**
 * 色号自然排序：先比字母前缀，再比数字。
 * `Intl.Collator` 的 numeric 选项能正确处理 A2 < A10。
 */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export function compareColorCodes(a: string, b: string): number {
  return collator.compare(a, b);
}

/** 一个色号的库存数量 = 其全部记录 delta 之和。 */
export function sumRecordDeltas(records: BeadRecord[] | undefined): number {
  if (!records || records.length === 0) return 0;
  let total = 0;
  for (const record of records) {
    if (typeof record?.delta === 'number' && Number.isFinite(record.delta)) {
      total += record.delta;
    }
  }
  return total;
}

/** 查询某色号当前库存；色号不存在按 0 计。 */
export function stockOf(inventory: BeadInventory | null | undefined, code: string): number {
  if (!inventory) return 0;
  return sumRecordDeltas(inventory.colors?.[code]?.records);
}

/** 豆仓里所有色号的库存合计（只累计正数，负数不抵减，便于看"手上总共有多少粒"）。 */
export function totalStock(inventory: BeadInventory | null | undefined): number {
  if (!inventory) return 0;
  let total = 0;
  for (const stock of Object.values(inventory.colors ?? {})) {
    total += Math.max(0, sumRecordDeltas(stock.records));
  }
  return total;
}

/**
 * 把作品的颜色统计（键为 hex）换算成豆仓色号用量。
 *
 * 同一色号对应多个 hex 时会累加；找不到映射的颜色（例如透明、擦除）直接跳过。
 */
export function mapHexCountsToConsumeLines(
  colorCounts: Record<string, { count: number; color: string }> | null | undefined,
  system: ColorSystem
): BeadConsumeLine[] {
  if (!colorCounts) return [];

  const byCode = new Map<string, number>();
  for (const [key, entry] of Object.entries(colorCounts)) {
    const rawHex = (key || entry?.color || '').trim().toUpperCase();
    const count = entry?.count ?? 0;
    if (!rawHex.startsWith('#') || !Number.isFinite(count) || count <= 0) continue;
    const code = mapping[rawHex]?.[system];
    if (!code) continue;
    byCode.set(code, (byCode.get(code) ?? 0) + count);
  }

  return Array.from(byCode.entries())
    .map(([color_code, quantity]) => ({ color_code, quantity }))
    .sort((a, b) => compareColorCodes(a.color_code, b.color_code));
}

/** 某作品在豆仓里的完成次数 = 引用该作品的 work 分组数。 */
export function countWorkCompletions(inventory: BeadInventory | null | undefined, projectId: string): number {
  if (!inventory || !projectId) return 0;
  const groups = new Set<string>();
  for (const stock of Object.values(inventory.colors ?? {})) {
    for (const record of stock.records ?? []) {
      if (record.type !== 'work' || record.project_id !== projectId) continue;
      groups.add(record.group_id || `${record.at}#${record.id}`);
    }
  }
  return groups.size;
}

/** 作品完成次数表：project_id → 次数。 */
export function buildCompletionCounts(inventory: BeadInventory | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!inventory) return counts;

  // 一次完成会跨多个色号写入同 group_id 的记录，这里按 group 去重后计数
  const groups = new Map<string, string>();
  for (const stock of Object.values(inventory.colors ?? {})) {
    for (const record of stock.records ?? []) {
      if (record.type !== 'work' || !record.project_id) continue;
      const groupId = record.group_id || `${record.at}#${record.id}`;
      if (!groups.has(groupId)) groups.set(groupId, record.project_id);
    }
  }
  for (const projectId of groups.values()) {
    counts[projectId] = (counts[projectId] ?? 0) + 1;
  }
  return counts;
}

/** 记录的人类可读描述（不含时间）。 */
export function describeRecord(record: BeadRecord): string {
  if (record.type === 'init') return '初始化';
  if (record.type === 'manual') return '手动调整';
  return record.project_title ? `作品《${record.project_title}》完成` : '作品完成';
}

/** 时间格式化；`local` 为 false 时用与语言环境无关的写法，避免预渲染水合不一致。 */
export function formatBeadTime(iso: string, local: boolean): string {
  if (!iso) return '';
  if (!local) return iso.slice(0, 16).replace('T', ' ');
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
