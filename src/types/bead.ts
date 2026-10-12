// 豆仓（拼豆库存）相关的共享类型。
//
// 这些类型同时被两条链路消费：
// 1. 浏览器端（`src/utils/apiClient.ts`、`src/utils/beadInventory.ts`、/beads 与 /works 页面）；
// 2. Cloudflare Pages Functions（`functions/api/beads/**`，通过相对路径 import 本文件）。
//
// 因此本文件必须保持"无副作用、无平台 API 依赖"，只放类型与纯常量。

import type { ColorSystem } from '../utils/pixelation';

/** 库存变动来源：初始化 / 手动增减 / 作品完成扣减。 */
export type BeadRecordType = 'init' | 'manual' | 'work';

/**
 * 一条库存操作记录。
 *
 * 库存数量一律 = 该色号下所有记录 `delta` 之和（不另存余额字段），
 * 这样删除任意一条记录后，数量天然变成"没有该操作时"的数字（见需求 3）。
 */
export interface BeadRecord {
  id: string;
  type: BeadRecordType;
  /** 变动量：正数入库，负数出库 */
  delta: number;
  /** 发生时间（ISO 8601） */
  at: string;
  /** 手动/初始化备注；作品完成记录里也冗余了一份作品名 */
  note?: string;
  /** type === 'work' 时关联的作品 ID */
  project_id?: string;
  /** type === 'work' 时关联的作品名；作品被删除后仍保留（见需求 6） */
  project_title?: string;
  /** 同一次「完成 1 次」跨多个色号共享的分组 ID，取消时整组删除 */
  group_id?: string;
}

/** 单个色号的库存记录集合。 */
export interface BeadColorStock {
  code: string;
  records: BeadRecord[];
}

/** 一个用户的整份豆仓。整体存在 KV 的单键里，读写都是"读改写"。 */
export interface BeadInventory {
  version: 1;
  initialized: boolean;
  /** 初始化时选定的色号系统；之后作品消耗按 hex 映射到该系统色号 */
  color_system: ColorSystem;
  created_at: string;
  updated_at: string;
  /** 色号 → 库存记录 */
  colors: Record<string, BeadColorStock>;
}

/** 初始化豆仓的请求体（色号列表由前端按色号系统算出，默认 MARD 221 色）。 */
export interface BeadInitPayload {
  color_system: ColorSystem;
  /** 每个色号的初始粒数 */
  default_quantity: number;
  colors: string[];
}

/** 手动增减库存的请求体。 */
export interface BeadManualRecordPayload {
  color_code: string;
  /** 正数增加，负数减少，不能为 0 */
  delta: number;
  note?: string;
}

/** 「完成 1 次」里单个色号的消耗量。 */
export interface BeadConsumeLine {
  color_code: string;
  quantity: number;
}

/** 「完成 1 次」的请求体：一次完成会跨多个色号，用同一个 group_id 记账。 */
export interface BeadCompletePayload {
  project_id: string;
  project_title: string;
  lines: BeadConsumeLine[];
}

export interface BeadInventoryResponse {
  inventory: BeadInventory;
}

export interface BeadCompleteResponse {
  inventory: BeadInventory;
  /** 本次写入的色号记录数 */
  created: number;
}

export interface BeadCancelResponse {
  inventory: BeadInventory;
  /** 被撤销的那次完成；没有可取消的记录时为 null */
  removed: { group_id: string; at: string; beads: number } | null;
}

/** 色号系统列表，与服务端校验共用。 */
export const BEAD_COLOR_SYSTEMS: ColorSystem[] = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'];

/** 单个色号库存记录的条数上限，防止异常客户端把 KV 值撑爆。 */
export const MAX_RECORDS_PER_COLOR = 5000;
/** 一次「完成 1 次」最多涉及的色号数。 */
export const MAX_CONSUME_LINES = 1000;
/** 初始化时最多允许建立的色号数。 */
export const MAX_INIT_COLORS = 2000;
