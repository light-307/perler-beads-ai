// 绑定校验：KV / R2 缺失时给出可操作的报错，而不是 500 TypeError。

import { ApiError, requireEnv } from './http';
import type { Env, KVNamespaceBinding, R2BucketBinding } from './env';

export function getKV(env: Env): KVNamespaceBinding {
  requireEnv(env, ['AUTH_SECRET']);
  if (!env.PB_KV) {
    throw new ApiError(
      500,
      'SERVER_NOT_CONFIGURED',
      '服务端没有绑定 KV 命名空间 PB_KV。请检查 wrangler.jsonc 里的 kv_namespaces，确认 binding 为 PB_KV 且 id 与 Cloudflare 控制台一致，然后重新部署。'
    );
  }
  return env.PB_KV;
}

export function getR2(env: Env): R2BucketBinding {
  if (!env.PB_R2) {
    throw new ApiError(
      500,
      'SERVER_NOT_CONFIGURED',
      '服务端没有绑定 R2 存储桶 PB_R2。请检查 wrangler.jsonc 里的 r2_buckets，确认 binding 为 PB_R2 且 bucket_name 与 Cloudflare 控制台一致，然后重新部署。'
    );
  }
  return env.PB_R2;
}
