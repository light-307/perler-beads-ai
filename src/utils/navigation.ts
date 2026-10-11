// 登录/注册成功后的跳转目标。
//
// 首页在检测到未登录却要打开云端作品时，会跳到 /login?next=...；
// 这里把 next 解析出来。只接受站内相对路径（以单个 / 开头），
// 否则退回 fallback，避免被构造成开放重定向。

export function resolveNextUrl(fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const raw = new URLSearchParams(window.location.search).get('next');
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) {
    return raw;
  }
  return fallback;
}
