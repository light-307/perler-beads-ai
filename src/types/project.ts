// 云端作品（项目）相关的共享类型。
//
// 这些类型同时被两条链路消费：
// 1. 浏览器端（`src/utils/apiClient.ts`、页面组件）；
// 2. Cloudflare Pages Functions（`functions/api/**`，通过相对路径 import 本文件）。
//
// 因此本文件必须保持"无副作用、无平台 API 依赖"，只放类型与纯常量。

import type { ColorSystem } from '../utils/pixelation';

/** 作品来源。保留 `handdrawn` / `ai` 是为了后续接入小程序手绘与 AI 生成链路。 */
export type ProjectSource = 'photo' | 'handdrawn' | 'ai';

/** 制作状态。与小程序 `pixel_art_gallery` 里的 status 字段保持一致。 */
export type ProjectStatus = 'unfinished' | 'finished';

/** 网格压缩格式标识。 */
export const GRID_FORMAT = 'pbgrid-v1' as const;
export type GridFormat = typeof GRID_FORMAT;

/**
 * 像素化参数快照。字段刻意与 `src/app/page.tsx` 中的 state 一一对应，
 * 以便"打开作品"时能完整还原出当时的生成条件（而不是只还原一张图）。
 */
export interface ProjectSettings {
  /** 横向格数 N */
  granularity: number;
  /** 纵向格数 M；为空表示按原图比例自动计算 */
  vertical_granularity: number | null;
  /** 是否锁定原图宽高比 */
  maintain_aspect_ratio?: boolean;
  /** 相似度合并阈值 */
  similarity: number;
  /** 像素化模式：dominant（卡通/主色）或 average（真实/平均色） */
  mode: 'dominant' | 'average';
  /** 当前选中的色号系统 */
  color_system?: ColorSystem;
  /** 已排除的颜色 key 列表（兼容旧数据的数组形式） */
  excluded_colors?: string[];
  /** 自定义色板选择：hex → 是否选中 */
  palette_selections?: Record<string, boolean>;
  /** 是否使用了自定义色板 */
  is_custom_palette?: boolean;
}

/** 单格像素的紧凑表示，用于压缩网格的中间结构。 */
export interface GridPayload {
  N: number;
  M: number;
  pixels: Array<{ k: string; hex: string; ext?: boolean }>;
}

/** 颜色统计中每个颜色的条目。 */
export interface ColorCountEntry {
  count: number;
  color: string;
}

/** 作品统计信息。 */
export interface ProjectStats {
  color_counts: Record<string, ColorCountEntry>;
  total_beads: number;
}

/** 服务端保存的网格元信息（不包含像素本身）。 */
export interface GridInfo {
  format: GridFormat;
  N: number;
  M: number;
  /** 使用的唯一颜色数（压缩调色板长度） */
  colors: number;
  /** 压缩后字节数 */
  bytes: number;
}

/** 作品在 R2 中的文件引用（值为对象 key，不是 URL）。 */
export interface ProjectFiles {
  original?: string;
  ai?: string;
  thumbnail?: string;
  grid?: string;
}

/** 每个 R2 对象的字节数，key 即对象 key。用于精确统计存储用量。 */
export type ProjectFileBytes = Record<string, number>;

/** 服务端 KV 中保存的作品元数据（不含网格像素与图片二进制）。 */
export interface ProjectMeta {
  id: string;
  user_id: string;
  title: string;
  description: string;
  tags: string[];
  source: ProjectSource;
  color_system: ColorSystem;
  settings: ProjectSettings;
  stats: ProjectStats;
  status: ProjectStatus;
  grid: GridInfo | null;
  files: ProjectFiles;
  /** 该作品在 R2 中占用的总字节数（= file_bytes 各项之和）；旧记录可能没有 */
  bytes?: number;
  /** 每个对象的字节数（对象 key → bytes），更新时用来算净增量 */
  file_bytes?: ProjectFileBytes;
  /** 兼容旧客户端的版本号；当前仅做自增，不做冲突合并 */
  version: number;
  created_at: string;
  updated_at: string;
}

/** 列表接口返回的精简条目。 */
export type ProjectSummary = ProjectMeta & {
  /** 缩略图访问地址（同源，需登录 Cookie） */
  thumbnail_url: string | null;
};

/** 详情接口在元数据之外附加压缩网格与文件访问地址。 */
export interface ProjectDetail extends ProjectMeta {
  /** 索引压缩后的网格（base64），未登录或旧数据可能为 null */
  grid_data: string | null;
  original_url: string | null;
  ai_url: string | null;
  thumbnail_url: string | null;
}

/** 创建/更新作品的请求体。 */
export interface ProjectWritePayload {
  title: string;
  description?: string;
  tags?: string[];
  source?: ProjectSource;
  color_system?: ColorSystem;
  settings?: Partial<ProjectSettings>;
  stats?: Partial<ProjectStats>;
  status?: ProjectStatus;
  /** 索引压缩网格（base64），由 `encodeGridToBase64` 生成 */
  grid?: string | null;
  /** 图片，data URL 形式（`data:image/png;base64,...`），可选 */
  images?: {
    original?: string | null;
    ai?: string | null;
    thumbnail?: string | null;
  };
}

/** 登录用户信息。 */
export interface AuthUser {
  id: string;
  username: string;
  nickname: string;
  /** 是否已绑定微信（当前恒为 false，仅为后续小程序打通预留） */
  wechat_bound?: boolean;
  created_at: string;
}

export interface AuthResponse {
  user: AuthUser;
}

/** 统一的错误响应体。 */
export interface ApiErrorBody {
  error: string;
  message?: string;
}

/**
 * 云端用量与自设上限（GET /api/quota）。
 *
 * 上限默认取 R2 免费额度的十分之一（1 GiB / 10 万次 Class A / 100 万次 Class B），
 * 可用环境变量覆盖；超限后服务端拒绝写入，前端据此提示用户。
 */
export interface QuotaStatus {
  storage_bytes: number;
  storage_limit_bytes: number;
  class_a_ops: number;
  class_a_limit: number;
  class_b_ops: number;
  class_b_limit: number;
  /** 计数所属月份（UTC，YYYY-MM） */
  month: string;
  /** 计数的重置时刻（下月 1 日 00:00 UTC） */
  resets_at: string;
}
