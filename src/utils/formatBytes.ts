// 字节数的可读写法。
//
// 前后端共用同一份实现：服务端用它拼配额超限的报错文案
// （functions/api/_lib/quota.ts），前端用它显示用量面板（src/app/works/page.tsx）。
// 这是纯函数、不依赖任何平台 API，所以在 Worker 里也能安全运行。

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}
