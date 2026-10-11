// 浏览器端调用云保存接口的唯一入口。
//
// 全部走同源相对路径（`/api/...`）：静态导出（output: "export"）没有服务端，
// 但 Cloudflare 部署时 Pages Functions 就挂在同一个域名下，所以不需要任何
// NEXT_PUBLIC_* 基础地址配置，也不需要在代码里写死任何域名。

import type { AuthUser, ProjectDetail, ProjectSummary, ProjectWritePayload, QuotaStatus } from '../types/project';

/** 接口返回的错误，带上 HTTP 状态码与服务端错误码便于页面区分文案。 */
export class ApiRequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }

  /** 服务端没配好环境变量（缺 AUTH_SECRET / KV / R2 绑定）。 */
  get isServerNotConfigured(): boolean {
    return this.code === 'SERVER_NOT_CONFIGURED';
  }

  /** 未登录或登录已过期。 */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * 触碰到了自设的 R2 用量上限：
   * - `STORAGE_QUOTA_EXCEEDED`（507）存储总量超过上限，保存被拒绝；
   * - `R2_OPERATION_LIMIT_EXCEEDED`（429）本月操作次数达到上限。
   * 两种情况都要用户先删除作品或调高环境变量，重试没有意义。
   */
  get isQuotaExceeded(): boolean {
    return this.code === 'STORAGE_QUOTA_EXCEEDED' || this.code === 'R2_OPERATION_LIMIT_EXCEEDED';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      // 会话是 HttpOnly Cookie，必须显式带上
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiRequestError(0, 'NETWORK_ERROR', '网络请求失败，请检查网络连接后重试');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; message?: string };
    throw new ApiRequestError(response.status, body.error ?? 'REQUEST_FAILED', body.message);
  }

  return payload as T;
}

// ------------------------------------------------------------------ 身份

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const data = await request<{ user: AuthUser | null }>('/api/auth/me');
  return data.user;
}

export async function registerAccount(input: { username: string; password: string; nickname?: string }): Promise<AuthUser> {
  const data = await request<{ user: AuthUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.user;
}

export async function loginAccount(input: { username: string; password: string }): Promise<AuthUser> {
  const data = await request<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.user;
}

export async function logoutAccount(): Promise<void> {
  await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

// ------------------------------------------------------------------ 作品

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>('/api/projects');
  return data.projects ?? [];
}

export async function createProject(payload: ProjectWritePayload): Promise<ProjectDetail> {
  const data = await request<{ project: ProjectDetail }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.project;
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const data = await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`);
  return data.project;
}

export async function updateProject(id: string, payload: ProjectWritePayload): Promise<ProjectDetail> {
  const data = await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return data.project;
}

export async function deleteProject(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ 用量

/** 当前 R2 用量与自设上限（存储总量 / Class A / Class B 次数）。 */
export async function getQuota(): Promise<QuotaStatus> {
  const data = await request<{ quota: QuotaStatus }>('/api/quota');
  return data.quota;
}

/**
 * 把图片 URL 读成 data URL。
 *
 * 作品详情里的 `original_url` / `ai_url` 是同源接口地址，需要登录 Cookie；
 * 用 fetch 取回后转 base64，才能交给既有的"从 data URL 载入图片"流程。
 */
export async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}
