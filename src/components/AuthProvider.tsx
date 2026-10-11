'use client';

// 全局登录态。
//
// 挂在 src/app/layout.tsx 的 <body> 下，让首页、/login、/works 都能拿到
// 当前用户，避免每个页面各自请求一次 /api/auth/me。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthUser } from '../types/project';
import { fetchCurrentUser, loginAccount, logoutAccount, registerAccount } from '../utils/apiClient';

interface AuthContextValue {
  /** 当前登录用户；未登录为 null */
  user: AuthUser | null;
  /** 首次拉取登录态是否还在进行中 */
  loading: boolean;
  /** 重新拉取登录态 */
  refresh: () => Promise<AuthUser | null>;
  login: (input: { username: string; password: string }) => Promise<AuthUser>;
  register: (input: { username: string; password: string; nickname?: string }) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const current = await fetchCurrentUser();
      setUser(current);
      return current;
    } catch (error) {
      // `npm run dev`（纯静态导出）下没有 Functions 运行时，这里会 404。
      // 这属于预期情况，静默当作未登录即可，不要打扰用户。
      console.warn('[auth] 获取登录态失败：', error);
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (input: { username: string; password: string }) => {
    const logged = await loginAccount(input);
    setUser(logged);
    return logged;
  }, []);

  const register = useCallback(async (input: { username: string; password: string; nickname?: string }) => {
    const created = await registerAccount(input);
    setUser(created);
    return created;
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutAccount();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, refresh, login, register, logout }),
    [user, loading, refresh, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth 必须在 <AuthProvider> 内部使用');
  }
  return context;
}
