import type { Metadata } from 'next';

// 这些页面是客户端组件（'use client'），不能自己导出 metadata，
// 因此由同级的 server layout 提供页面标题。
export const metadata: Metadata = {
  title: '我的豆仓 | LDB拼豆底稿生成器',
};

export default function BeadsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
