// 作品仓储：元数据在 KV，网格与图片在 R2。
//
// KV 键：`proj:{userId}:{projectId}` → ProjectMeta JSON
// R2 键：`u/{userId}/{projectId}/{grid.bin|original.ext|ai.ext|thumb.png}`
//
// R2 键以 `u/{userId}/` 开头，`functions/api/files/[[path]].ts` 靠这个前缀做鉴权。

import { ApiError } from './http';
import type { Env } from './env';
import { getKV } from './store';
import { base64ToBytes, bytesToBase64 } from './crypto';
// R2 一律走 quota.ts 的包装函数，这样存储总量与 Class A / Class B 操作次数都会被记账，
// 用量上限（见 docs/部署/Cloudflare云保存配置.md「用量上限」）才真正生效。
import {
  commitStorageDelta,
  ensureStorageAvailable,
  projectStoredBytes,
  r2DeleteObjects,
  r2GetObject,
  r2ListObjects,
  r2PutObject,
} from './quota';
// 网格格式只有一份实现：前端编码、服务端校验共用 src/utils/gridCodec.ts。
// 该模块只用 TextEncoder/TextDecoder/Uint8Array，在 Worker 里可以安全运行。
import { readGridInfo, GridCodecError } from '../../../src/utils/gridCodec';
import { GRID_FORMAT } from '../../../src/types/project';
import type {
  ColorCountEntry,
  GridInfo,
  ProjectFileBytes,
  ProjectFiles,
  ProjectMeta,
  ProjectSettings,
  ProjectSource,
  ProjectStats,
  ProjectStatus,
  ProjectWritePayload,
} from '../../../src/types/project';

const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 30;
/** 原图 / AI 图单张上限 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 缩略图上限 */
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
/** 压缩网格上限（60KB 量级，留足余量） */
const MAX_GRID_BYTES = 4 * 1024 * 1024;

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const PROJECT_SOURCES: ProjectSource[] = ['photo', 'handdrawn', 'ai'];
const PROJECT_STATUSES: ProjectStatus[] = ['unfinished', 'finished'];

export function assertProjectId(id: string): string {
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(400, 'INVALID_PROJECT_ID', '作品 ID 不合法');
  }
  return id;
}

const projectKey = (userId: string, projectId: string) => `proj:${userId}:${projectId}`;
const projectPrefix = (userId: string) => `proj:${userId}:`;

export const gridObjectKey = (userId: string, projectId: string) => `u/${userId}/${projectId}/grid.bin`;
export const imageObjectKey = (userId: string, projectId: string, kind: 'original' | 'ai' | 'thumb', ext: string) =>
  `u/${userId}/${projectId}/${kind}.${ext}`;

/** R2 对象 key → 同源访问地址。避免在任何响应里内联 base64 图片。 */
export function fileUrl(key: string | undefined | null): string | null {
  return key ? `/api/files/${key}` : null;
}

// ---------------------------------------------------------------- 数据规整

function asString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    const tag = asString(item, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function normalizeSettings(value: unknown, fallbackColorSystem: string): ProjectSettings {
  const raw = (value ?? {}) as Record<string, unknown>;
  const vertical = raw.vertical_granularity;
  const mode = raw.mode === 'dominant' ? 'dominant' : 'average';
  const paletteSelections = raw.palette_selections;
  const excludedColors = raw.excluded_colors;

  return {
    granularity: Math.max(1, Math.round(asFiniteNumber(raw.granularity, 50))),
    vertical_granularity:
      vertical === null || vertical === undefined || vertical === '' ? null : Math.max(1, Math.round(asFiniteNumber(vertical, 1))),
    maintain_aspect_ratio: raw.maintain_aspect_ratio === undefined ? true : Boolean(raw.maintain_aspect_ratio),
    similarity: Math.round(asFiniteNumber(raw.similarity, 30)),
    mode,
    color_system: (asString(raw.color_system, 16) || fallbackColorSystem) as ProjectSettings['color_system'],
    excluded_colors: Array.isArray(excludedColors) ? excludedColors.map((item) => asString(item, 32)).filter(Boolean) : [],
    palette_selections:
      paletteSelections && typeof paletteSelections === 'object'
        ? Object.fromEntries(
            Object.entries(paletteSelections as Record<string, unknown>)
              .slice(0, 2000)
              .map(([hex, selected]) => [hex, Boolean(selected)])
          )
        : {},
    is_custom_palette: Boolean(raw.is_custom_palette),
  };
}

function normalizeStats(value: unknown): ProjectStats {
  const raw = (value ?? {}) as Record<string, unknown>;
  const counts: Record<string, ColorCountEntry> = {};
  const source = raw.color_counts;
  if (source && typeof source === 'object') {
    for (const [key, entry] of Object.entries(source as Record<string, unknown>).slice(0, 2000)) {
      const item = (entry ?? {}) as Record<string, unknown>;
      const count = Math.max(0, Math.round(asFiniteNumber(item.count, 0)));
      counts[key] = { count, color: asString(item.color, 16) };
    }
  }
  const total = raw.total_beads;
  const totalBeads =
    total === undefined ? Object.values(counts).reduce((sum, item) => sum + item.count, 0) : Math.max(0, Math.round(asFiniteNumber(total, 0)));
  return { color_counts: counts, total_beads: totalBeads };
}

interface DecodedImage {
  bytes: Uint8Array;
  ext: string;
}

function decodeImageDataUrl(value: unknown, maxBytes: number, label: string): DecodedImage | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_IMAGE', `${label}必须是 data URL 字符串`);
  }
  const match = DATA_URL_PATTERN.exec(value.trim());
  if (!match) {
    throw new ApiError(400, 'INVALID_IMAGE', `${label}不是受支持的图片 data URL（仅支持 png / jpeg / webp / gif）`);
  }
  const mime = match[1].toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw new ApiError(400, 'INVALID_IMAGE', `${label}的图片格式不支持`);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(match[2]);
  } catch {
    throw new ApiError(400, 'INVALID_IMAGE', `${label}的 base64 数据无法解析`);
  }
  if (bytes.length === 0) {
    throw new ApiError(400, 'INVALID_IMAGE', `${label}是空图片`);
  }
  if (bytes.length > maxBytes) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', `${label}体积 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超过上限 ${maxBytes / 1024 / 1024}MB`);
  }
  return { bytes, ext };
}

function decodeGridBase64(value: string): { bytes: Uint8Array; info: GridInfo } {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new ApiError(400, 'INVALID_GRID', '网格 base64 数据无法解析');
  }
  if (bytes.length > MAX_GRID_BYTES) {
    throw new ApiError(413, 'GRID_TOO_LARGE', `网格体积 ${(bytes.length / 1024).toFixed(0)}KB，超过上限 ${MAX_GRID_BYTES / 1024}KB`);
  }
  try {
    const info = readGridInfo(bytes);
    return { bytes, info: { format: GRID_FORMAT, N: info.N, M: info.M, colors: info.colors, bytes: info.bytes } };
  } catch (error) {
    if (error instanceof GridCodecError) {
      throw new ApiError(400, 'INVALID_GRID', `网格数据不合法：${error.message}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------- 读写

export async function getProject(env: Env, userId: string, projectId: string): Promise<ProjectMeta | null> {
  const raw = await getKV(env).get(projectKey(userId, projectId), 'text');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectMeta;
  } catch {
    return null;
  }
}

export async function requireProject(env: Env, userId: string, projectId: string): Promise<ProjectMeta> {
  const project = await getProject(env, userId, projectId);
  if (!project) {
    throw new ApiError(404, 'PROJECT_NOT_FOUND', '作品不存在或已被删除');
  }
  return project;
}

/** 列出当前用户的全部作品，按更新时间倒序。 */
export async function listProjects(env: Env, userId: string): Promise<ProjectMeta[]> {
  const namespace = getKV(env);
  const prefix = projectPrefix(userId);
  const keys: string[] = [];
  let cursor: string | undefined;

  // 个人自用规模有限；限制翻页次数，避免异常数据把请求拖死
  for (let page = 0; page < 10; page += 1) {
    const result = await namespace.list({ prefix, cursor, limit: 1000 });
    keys.push(...result.keys.map((item) => item.name));
    if (result.list_complete || !result.cursor) break;
    cursor = result.cursor;
  }

  const projects = await Promise.all(keys.map((key) => namespace.get(key, 'text')));
  const parsed = projects
    .map((raw) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw) as ProjectMeta;
      } catch {
        return null;
      }
    })
    .filter((item): item is ProjectMeta => Boolean(item));

  return parsed.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

async function putObject(env: Env, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await r2PutObject(env, key, bytes, {
    httpMetadata: {
      contentType,
      // 图片内容按 key 固定不变，可长缓存；但必须带 Cookie 才能取，所以加 private
      cacheControl: 'private, max-age=31536000, immutable',
    },
  });
}

async function removeObjects(env: Env, keys: Array<string | undefined>): Promise<void> {
  const targets = keys.filter((key): key is string => Boolean(key));
  if (targets.length === 0) return;
  await r2DeleteObjects(env, targets);
}

function sumBytes(map: ProjectFileBytes): number {
  return Object.values(map).reduce((sum, value) => sum + value, 0);
}

/**
 * 取一件作品当前各对象的字节数。
 *
 * 新记录直接读 `file_bytes`；没有该字段的旧记录（本功能上线前保存的）向 R2
 * 列举一次补齐 —— 只发生在该作品第一次被更新时，之后就一直走元数据了。
 */
async function resolveFileBytes(env: Env, userId: string, projectId: string, project: ProjectMeta): Promise<ProjectFileBytes> {
  const known = project.file_bytes;
  if (known && typeof known === 'object') {
    const result: ProjectFileBytes = {};
    for (const [key, value] of Object.entries(known)) {
      const size = Number(value);
      if (Number.isFinite(size) && size > 0) result[key] = Math.floor(size);
    }
    return result;
  }
  try {
    const listed = await r2ListObjects(env, `u/${userId}/${projectId}/`, 1000);
    return Object.fromEntries(listed.objects.map((item) => [item.key, item.size]));
  } catch {
    // 列举失败就按 0 处理：这次更新会把新写入的对象全额计进用量（偏保守）
    return {};
  }
}

export async function createProject(env: Env, userId: string, payload: ProjectWritePayload): Promise<ProjectMeta> {
  const title = asString(payload?.title, MAX_TITLE_LENGTH);
  if (!title) {
    throw new ApiError(400, 'INVALID_TITLE', '作品名称不能为空');
  }
  if (!payload?.grid || typeof payload.grid !== 'string') {
    throw new ApiError(400, 'MISSING_GRID', '缺少网格数据，无法保存作品');
  }

  const projectId = crypto.randomUUID();
  const { bytes: gridBytes, info: gridInfo } = decodeGridBase64(payload.grid);
  const gridKey = gridObjectKey(userId, projectId);

  const images = payload.images ?? {};
  const original = decodeImageDataUrl(images.original, MAX_IMAGE_BYTES, '原图');
  const ai = decodeImageDataUrl(images.ai, MAX_IMAGE_BYTES, 'AI 优化图');
  const thumbnail = decodeImageDataUrl(images.thumbnail, MAX_THUMBNAIL_BYTES, '缩略图');

  // 先把"要写哪些对象、各占多少字节"全部算清楚再做配额检查，
  // 这样一旦超限，一个字节都还没写进 R2。
  const files: ProjectFiles = { grid: gridKey };
  const fileBytes: ProjectFileBytes = { [gridKey]: gridBytes.length };
  const pending: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [
    { key: gridKey, bytes: gridBytes, contentType: 'application/octet-stream' },
  ];

  const addImage = (
    kind: 'original' | 'ai' | 'thumb',
    field: 'original' | 'ai' | 'thumbnail',
    image: DecodedImage | null
  ): void => {
    if (!image) return;
    const ext = kind === 'thumb' ? 'png' : image.ext;
    const key = imageObjectKey(userId, projectId, kind, ext);
    files[field] = key;
    fileBytes[key] = image.bytes.length;
    pending.push({
      key,
      bytes: image.bytes,
      contentType: kind === 'thumb' ? 'image/png' : `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    });
  };

  addImage('original', 'original', original);
  addImage('ai', 'ai', ai);
  addImage('thumb', 'thumbnail', thumbnail);

  const totalBytes = sumBytes(fileBytes);
  await ensureStorageAvailable(env, totalBytes);

  try {
    for (const item of pending) {
      await putObject(env, item.key, item.bytes, item.contentType);
    }
  } catch (error) {
    // 写到一半失败就把这次已经落盘的对象清掉，避免 R2 里留下没有元数据的孤儿文件
    try {
      await removeObjects(env, pending.map((item) => item.key));
    } catch (cleanupError) {
      console.error('[projects] 回滚 R2 对象失败:', cleanupError);
    }
    throw error;
  }

  await commitStorageDelta(env, totalBytes);

  const now = new Date().toISOString();
  const colorSystem = asString(payload.color_system, 16) || 'MARD';
  const source = PROJECT_SOURCES.includes(payload.source as ProjectSource) ? (payload.source as ProjectSource) : 'photo';
  const status = PROJECT_STATUSES.includes(payload.status as ProjectStatus) ? (payload.status as ProjectStatus) : 'unfinished';

  const project: ProjectMeta = {
    id: projectId,
    user_id: userId,
    title,
    description: asString(payload.description, MAX_DESCRIPTION_LENGTH),
    tags: normalizeTags(payload.tags),
    source,
    color_system: colorSystem as ProjectMeta['color_system'],
    settings: normalizeSettings(payload.settings, colorSystem),
    stats: normalizeStats(payload.stats),
    status,
    grid: gridInfo,
    files,
    file_bytes: fileBytes,
    bytes: totalBytes,
    version: 1,
    created_at: now,
    updated_at: now,
  };

  await getKV(env).put(projectKey(userId, projectId), JSON.stringify(project));
  return project;
}

export async function updateProject(env: Env, userId: string, projectId: string, payload: ProjectWritePayload): Promise<ProjectMeta> {
  const existing = await requireProject(env, userId, projectId);
  const title = payload?.title === undefined ? existing.title : asString(payload.title, MAX_TITLE_LENGTH);
  if (!title) {
    throw new ApiError(400, 'INVALID_TITLE', '作品名称不能为空');
  }

  const files: ProjectFiles = { ...existing.files };
  const fileBytes: ProjectFileBytes = await resolveFileBytes(env, userId, projectId, existing);
  const staleKeys: string[] = [];
  // 本次更新带来的存储净增量（正数表示占用变大），写完元数据后累加到全局计数
  let storageDelta = 0;
  let gridInfo = existing.grid;
  const writes: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];

  // 网格：只有显式传了才覆盖；覆盖后要删掉旧对象（文件后缀相同，key 一致，无需替换）
  if (typeof payload?.grid === 'string' && payload.grid) {
    const { bytes: gridBytes, info } = decodeGridBase64(payload.grid);
    const gridKey = gridObjectKey(userId, projectId);
    storageDelta += gridBytes.length - (fileBytes[gridKey] ?? 0);
    fileBytes[gridKey] = gridBytes.length;
    if (files.grid && files.grid !== gridKey) {
      staleKeys.push(files.grid);
      storageDelta -= fileBytes[files.grid] ?? 0;
      delete fileBytes[files.grid];
    }
    files.grid = gridKey;
    gridInfo = info;
    writes.push({ key: gridKey, bytes: gridBytes, contentType: 'application/octet-stream' });
  }

  const images = payload?.images ?? {};
  const nextImages: Array<{ kind: 'original' | 'ai' | 'thumb'; field: 'original' | 'ai' | 'thumbnail'; decoded: DecodedImage | null }> = [
    { kind: 'original', field: 'original', decoded: decodeImageDataUrl(images.original, MAX_IMAGE_BYTES, '原图') },
    { kind: 'ai', field: 'ai', decoded: decodeImageDataUrl(images.ai, MAX_IMAGE_BYTES, 'AI 优化图') },
    { kind: 'thumb', field: 'thumbnail', decoded: decodeImageDataUrl(images.thumbnail, MAX_THUMBNAIL_BYTES, '缩略图') },
  ];

  for (const item of nextImages) {
    if (!item.decoded) continue;
    const ext = item.kind === 'thumb' ? 'png' : item.decoded.ext;
    const key = imageObjectKey(userId, projectId, item.kind, ext);
    const mime = item.kind === 'thumb' ? 'image/png' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    storageDelta += item.decoded.bytes.length - (fileBytes[key] ?? 0);
    fileBytes[key] = item.decoded.bytes.length;
    // 换了格式（png → jpg）时 key 会变，旧对象要清掉
    const previous = files[item.field];
    if (previous && previous !== key) {
      staleKeys.push(previous);
      storageDelta -= fileBytes[previous] ?? 0;
      delete fileBytes[previous];
    }
    files[item.field] = key;
    writes.push({ key, bytes: item.decoded.bytes, contentType: mime });
  }

  const nextBytes = sumBytes(fileBytes);
  // 先检查再写：覆盖成更小文件（storageDelta < 0）时 ensureStorageAvailable 直接放行
  await ensureStorageAvailable(env, storageDelta);

  for (const item of writes) {
    await putObject(env, item.key, item.bytes, item.contentType);
  }

  const colorSystem = asString(payload?.color_system, 16) || existing.color_system;
  const project: ProjectMeta = {
    ...existing,
    title,
    description: payload?.description === undefined ? existing.description : asString(payload.description, MAX_DESCRIPTION_LENGTH),
    tags: payload?.tags === undefined ? existing.tags : normalizeTags(payload.tags),
    source: PROJECT_SOURCES.includes(payload?.source as ProjectSource) ? (payload!.source as ProjectSource) : existing.source,
    color_system: colorSystem as ProjectMeta['color_system'],
    settings: payload?.settings === undefined ? existing.settings : normalizeSettings(payload.settings, colorSystem),
    stats: payload?.stats === undefined ? existing.stats : normalizeStats(payload.stats),
    status: PROJECT_STATUSES.includes(payload?.status as ProjectStatus) ? (payload!.status as ProjectStatus) : existing.status,
    grid: gridInfo,
    files,
    file_bytes: fileBytes,
    bytes: nextBytes,
    // version 只做自增，不做冲突合并（当前不支持多设备同时编辑）
    version: (existing.version ?? 1) + 1,
    updated_at: new Date().toISOString(),
  };

  await getKV(env).put(projectKey(userId, projectId), JSON.stringify(project));
  await removeObjects(env, staleKeys);
  await commitStorageDelta(env, storageDelta);
  return project;
}

export async function deleteProject(env: Env, userId: string, projectId: string): Promise<void> {
  const project = await requireProject(env, userId, projectId);
  await getKV(env).delete(projectKey(userId, projectId));

  const keys = [project.files.grid, project.files.original, project.files.ai, project.files.thumbnail];
  // 兜底：把该作品目录下可能残留的对象一并清掉
  let removedBytes = projectStoredBytes(project);
  try {
    const listed = await r2ListObjects(env, `u/${userId}/${projectId}/`, 1000);
    for (const object of listed.objects) keys.push(object.key);
    // 列举结果比元数据更权威（顺带覆盖残留的孤儿对象）
    if (listed.objects.length > 0) {
      removedBytes = listed.objects.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    }
  } catch {
    // 列举失败不影响删除主流程，前面已知的 key 照删，字节数退回用元数据里的值
  }
  await removeObjects(env, keys);
  await commitStorageDelta(env, -removedBytes);
}

/** 读取网格二进制并转成 base64（详情接口用）。 */
export async function readGridBase64(env: Env, key: string | undefined): Promise<string | null> {
  if (!key) return null;
  const object = await r2GetObject(env, key);
  if (!object) return null;
  const buffer = await new Response(object.body).arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

/** 删除某用户某作品之外的所有对象（暂未使用，保留给后续"清空回收站"）。 */
export async function listProjectObjects(env: Env, userId: string, projectId: string): Promise<string[]> {
  const listed = await r2ListObjects(env, `u/${userId}/${projectId}/`, 1000);
  return listed.objects.map((item) => item.key);
}
