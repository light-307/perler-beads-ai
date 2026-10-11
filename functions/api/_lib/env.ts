// Pages Functions 运行时的最小类型定义。
//
// 这里刻意不引入 `@cloudflare/workers-types`：仓库的 tsconfig 把 `functions/`
// 排除在类型检查之外，且我们只需要 KV / R2 的少数几个方法。自己声明可以
// 让服务端代码在任意 TS 配置下都能读懂，也避免新增一个开发依赖。

export interface KVListResult {
  keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
  list_complete: boolean;
  cursor?: string;
}

export interface KVNamespaceBinding {
  get(key: string, type?: 'text'): Promise<string | null>;
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KVListResult>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  writeHttpMetadata?(headers: Headers): void;
}

export interface R2BucketBinding {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | string | ReadableStream,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }
  ): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface Env {
  /** 火山引擎密钥（AI 优化用，见 functions/api/ai-optimize.ts） */
  VOLC_ACCESS_KEY_ID?: string;
  VOLC_SECRET_ACCESS_KEY?: string;
  /** 会话 token 签名密钥，必填；见 docs/部署/Cloudflare云保存配置.md */
  AUTH_SECRET?: string;
  /**
   * R2 用量上限覆盖值（都可选，留空用 quota.ts 里的默认值）：
   * 存储总量默认 1 GiB，Class A 默认 10 万次/月，Class B 默认 100 万次/月。
   * 见 docs/部署/Cloudflare云保存配置.md「用量上限」一节。
   */
  R2_STORAGE_LIMIT_BYTES?: string;
  R2_CLASS_A_LIMIT?: string;
  R2_CLASS_B_LIMIT?: string;
  /** 作品元数据（KV） */
  PB_KV: KVNamespaceBinding;
  /** 作品网格与图片（R2） */
  PB_R2: R2BucketBinding;
  /** 静态资源，Pages 提供 */
  ASSETS?: unknown;
}

/** Pages Functions 传给处理器的上下文（只列出本项目用到的字段）。 */
export interface PagesContext<E = Env> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  waitUntil(promise: Promise<unknown>): void;
  next(): Promise<Response>;
  data: Record<string, unknown>;
}
