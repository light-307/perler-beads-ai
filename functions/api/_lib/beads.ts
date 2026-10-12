// 豆仓仓储：整份库存存在 KV 的单键里。
//
// KV 键：`beadinv:{userId}` → BeadInventory JSON
//
// 设计要点：
// - 每个色号的库存数量一律由记录 `delta` 求和得到，不另存余额字段，
//   所以删除任意一条记录后数量天然回到"没有该操作时"的数字；
// - 一次「完成 1 次」会跨多个色号写记录，用同一个 group_id 串起来，
//   「取消 1 次」就是删掉最近的这个 group；
// - 记录里冗余保存了作品名，作品被编辑或删除都不回溯影响历史记录。

import { ApiError } from './http';
import type { Env } from './env';
import { getKV } from './store';
import {
  BEAD_COLOR_SYSTEMS,
  MAX_CONSUME_LINES,
  MAX_INIT_COLORS,
  MAX_RECORDS_PER_COLOR,
} from '../../../src/types/bead';
import type {
  BeadCancelResponse,
  BeadColorStock,
  BeadCompletePayload,
  BeadCompleteResponse,
  BeadConsumeLine,
  BeadInitPayload,
  BeadInventory,
  BeadManualRecordPayload,
  BeadRecord,
} from '../../../src/types/bead';
import type { ColorSystem } from '../../../src/utils/pixelation';

const COLOR_CODE_PATTERN = /^[A-Za-z0-9]{1,16}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PROJECT_TITLE_LENGTH = 100;
const MAX_NOTE_LENGTH = 200;
/** 单次变动量上限，防止误输入把数字撑到不可读 */
const MAX_DELTA = 1_000_000_000;

const inventoryKey = (userId: string) => `beadinv:${userId}`;

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function assertInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError(400, 'INVALID_BEAD_VALUE', `${field} 必须是整数`);
  }
  if (value < min || value > max) {
    throw new ApiError(400, 'INVALID_BEAD_VALUE', `${field} 超出允许范围（${min} ~ ${max}）`);
  }
  return value;
}

function assertColorCode(value: unknown): string {
  if (typeof value !== 'string' || !COLOR_CODE_PATTERN.test(value)) {
    throw new ApiError(400, 'INVALID_COLOR_CODE', '色号不合法');
  }
  return value;
}

function assertProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new ApiError(400, 'INVALID_PROJECT_ID', '作品 ID 不合法');
  }
  return value;
}

/** 把 KV 里读到的任意内容收敛成合法结构，脏数据只丢弃不报错。 */
function normalizeInventory(raw: unknown): BeadInventory | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<BeadInventory>;

  const colors: Record<string, BeadColorStock> = {};
  if (candidate.colors && typeof candidate.colors === 'object') {
    for (const [code, value] of Object.entries(candidate.colors as Record<string, BeadColorStock>)) {
      if (!value || typeof value !== 'object') continue;
      const records = Array.isArray(value.records)
        ? (value.records.filter((record) => record && typeof record === 'object') as BeadRecord[])
        : [];
      colors[code] = { code, records };
    }
  }

  const system = BEAD_COLOR_SYSTEMS.includes(candidate.color_system as ColorSystem)
    ? (candidate.color_system as ColorSystem)
    : 'MARD';

  return {
    version: 1,
    initialized: candidate.initialized === true,
    color_system: system,
    created_at: typeof candidate.created_at === 'string' ? candidate.created_at : nowIso(),
    updated_at: typeof candidate.updated_at === 'string' ? candidate.updated_at : nowIso(),
    colors,
  };
}

export async function readInventory(env: Env, userId: string): Promise<BeadInventory | null> {
  const namespace = getKV(env);
  const raw = await namespace.get(inventoryKey(userId), 'text');
  if (!raw) return null;
  try {
    return normalizeInventory(JSON.parse(raw));
  } catch {
    // 值被写坏时当作没有豆仓，让用户重新初始化，而不是让接口 500
    console.error('[beads] 豆仓数据解析失败，已忽略');
    return null;
  }
}

async function writeInventory(env: Env, userId: string, inventory: BeadInventory): Promise<void> {
  const namespace = getKV(env);
  inventory.updated_at = nowIso();
  await namespace.put(inventoryKey(userId), JSON.stringify(inventory));
}

/** 读取并校验"已经初始化过"的豆仓。 */
async function requireInventory(env: Env, userId: string): Promise<BeadInventory> {
  const inventory = await readInventory(env, userId);
  if (!inventory || !inventory.initialized || Object.keys(inventory.colors).length === 0) {
    throw new ApiError(404, 'BEAD_INVENTORY_NOT_INITIALIZED', '还没有初始化豆仓，请先到「我的豆仓」选择色号系统并录入初始库存。');
  }
  return inventory;
}

function pushRecord(color: BeadColorStock, record: BeadRecord): void {
  if (color.records.length >= MAX_RECORDS_PER_COLOR) {
    throw new ApiError(
      409,
      'BEAD_RECORD_LIMIT',
      `色号 ${color.code} 的操作记录已达到 ${MAX_RECORDS_PER_COLOR} 条上限，请先清理一些历史记录。`
    );
  }
  color.records.push(record);
}

/** 初始化豆仓：为每个色号写入一条「初始化 +N 粒」记录。 */
export async function initializeInventory(env: Env, userId: string, payload: BeadInitPayload): Promise<BeadInventory> {
  const existing = await readInventory(env, userId);
  if (existing?.initialized) {
    throw new ApiError(409, 'BEAD_INVENTORY_ALREADY_INITIALIZED', '豆仓已经初始化过了，无需重复初始化。');
  }

  const system = payload?.color_system;
  if (!BEAD_COLOR_SYSTEMS.includes(system)) {
    throw new ApiError(400, 'INVALID_COLOR_SYSTEM', '色号系统不合法');
  }

  const quantity = assertInteger(payload?.default_quantity, '每个色号的初始粒数', 0, MAX_DELTA);

  if (!Array.isArray(payload?.colors) || payload.colors.length === 0) {
    throw new ApiError(400, 'INVALID_BEAD_COLORS', '请至少提供一个色号');
  }
  if (payload.colors.length > MAX_INIT_COLORS) {
    throw new ApiError(400, 'INVALID_BEAD_COLORS', `一次最多初始化 ${MAX_INIT_COLORS} 个色号`);
  }

  const at = nowIso();
  const colors: Record<string, BeadColorStock> = {};
  for (const rawCode of payload.colors) {
    const code = assertColorCode(rawCode);
    if (colors[code]) continue; // 同一色号只建一次
    const color: BeadColorStock = { code, records: [] };
    if (quantity > 0) {
      color.records.push({ id: newId(), type: 'init', delta: quantity, at, note: '初始化' });
    }
    colors[code] = color;
  }

  if (Object.keys(colors).length === 0) {
    throw new ApiError(400, 'INVALID_BEAD_COLORS', '请至少提供一个色号');
  }

  const inventory: BeadInventory = {
    version: 1,
    initialized: true,
    color_system: system,
    created_at: at,
    updated_at: at,
    colors,
  };

  await writeInventory(env, userId, inventory);
  return inventory;
}

/** 手动增减某个色号的库存。 */
export async function addManualRecord(
  env: Env,
  userId: string,
  payload: BeadManualRecordPayload
): Promise<BeadInventory> {
  const inventory = await requireInventory(env, userId);
  const code = assertColorCode(payload?.color_code);
  const delta = assertInteger(payload?.delta, '变动数量', -MAX_DELTA, MAX_DELTA);
  if (delta === 0) {
    throw new ApiError(400, 'INVALID_BEAD_VALUE', '变动数量不能为 0');
  }

  const color = inventory.colors[code];
  if (!color) {
    throw new ApiError(404, 'BEAD_COLOR_NOT_FOUND', `豆仓里没有色号 ${code}，请先重新初始化或改用其他色号。`);
  }

  const note = typeof payload?.note === 'string' ? payload.note.trim().slice(0, MAX_NOTE_LENGTH) : '';
  pushRecord(color, {
    id: newId(),
    type: 'manual',
    delta,
    at: nowIso(),
    ...(note ? { note } : {}),
  });

  await writeInventory(env, userId, inventory);
  return inventory;
}

/** 删除一条操作记录；库存数量随之回到该记录不存在时的值。 */
export async function deleteRecord(env: Env, userId: string, recordId: string): Promise<BeadInventory> {
  if (typeof recordId !== 'string' || !recordId) {
    throw new ApiError(400, 'INVALID_RECORD_ID', '缺少记录 ID');
  }
  const inventory = await requireInventory(env, userId);

  let found = false;
  for (const color of Object.values(inventory.colors)) {
    const index = color.records.findIndex((record) => record.id === recordId);
    if (index >= 0) {
      color.records.splice(index, 1);
      found = true;
      break;
    }
  }
  if (!found) {
    throw new ApiError(404, 'BEAD_RECORD_NOT_FOUND', '这条记录不存在或已被删除');
  }

  await writeInventory(env, userId, inventory);
  return inventory;
}

/**
 * 「完成 1 次」：按作品当前各色号用量扣减库存。
 *
 * 作品用到豆仓里没有的色号时会自动建一个从 0 开始的色号（扣成负数），
 * 这样"按当前作品用量如实记账"不会被初始化时的 221 色限制卡住。
 */
export async function completeWork(
  env: Env,
  userId: string,
  payload: BeadCompletePayload
): Promise<BeadCompleteResponse> {
  const inventory = await requireInventory(env, userId);
  const projectId = assertProjectId(payload?.project_id);
  const projectTitle =
    typeof payload?.project_title === 'string' && payload.project_title.trim()
      ? payload.project_title.trim().slice(0, MAX_PROJECT_TITLE_LENGTH)
      : '未命名作品';

  if (!Array.isArray(payload?.lines) || payload.lines.length === 0) {
    throw new ApiError(400, 'INVALID_BEAD_LINES', '这个作品没有可扣减的颜色用量');
  }
  if (payload.lines.length > MAX_CONSUME_LINES) {
    throw new ApiError(400, 'INVALID_BEAD_LINES', `一次最多扣减 ${MAX_CONSUME_LINES} 个色号`);
  }

  // 同一色号可能被多个 hex 引用，先合并用量
  const merged = new Map<string, number>();
  for (const line of payload.lines as BeadConsumeLine[]) {
    const code = assertColorCode(line?.color_code);
    const quantity = assertInteger(line?.quantity, '用量', 1, MAX_DELTA);
    merged.set(code, (merged.get(code) ?? 0) + quantity);
  }

  const at = nowIso();
  const groupId = newId();
  let created = 0;

  for (const [code, quantity] of merged) {
    let color = inventory.colors[code];
    if (!color) {
      color = { code, records: [] };
      inventory.colors[code] = color;
    }
    pushRecord(color, {
      id: newId(),
      type: 'work',
      delta: -quantity,
      at,
      note: projectTitle,
      project_id: projectId,
      project_title: projectTitle,
      group_id: groupId,
    });
    created += 1;
  }

  await writeInventory(env, userId, inventory);
  return { inventory, created };
}

/**
 * 「取消 1 次」：删掉该作品最近一次完成的整组记录。
 * 找不到时返回 removed: null，由前端提示"没有可取消的记录"。
 */
export async function cancelWork(env: Env, userId: string, projectIdRaw: unknown): Promise<BeadCancelResponse> {
  const inventory = await requireInventory(env, userId);
  const projectId = assertProjectId(projectIdRaw);

  // 找出该作品所有完成记录里时间最晚的那个 group
  let latest: { groupId: string; at: string } | null = null;
  for (const color of Object.values(inventory.colors)) {
    for (const record of color.records) {
      if (record.type !== 'work' || record.project_id !== projectId || !record.group_id) continue;
      if (!latest || record.at > latest.at) {
        latest = { groupId: record.group_id, at: record.at };
      }
    }
  }

  if (!latest) {
    return { inventory, removed: null };
  }

  let beads = 0;
  for (const color of Object.values(inventory.colors)) {
    const kept: BeadRecord[] = [];
    for (const record of color.records) {
      if (record.group_id === latest.groupId && record.type === 'work' && record.project_id === projectId) {
        beads += Math.abs(record.delta);
        continue;
      }
      kept.push(record);
    }
    color.records = kept;
  }

  await writeInventory(env, userId, inventory);
  return { inventory, removed: { group_id: latest.groupId, at: latest.at, beads } };
}
