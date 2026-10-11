'use client';

// 登录页。/login

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/AuthProvider';
import { ApiRequestError } from '../../utils/apiClient';
import { resolveNextUrl } from '../../utils/navigation';

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, login } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已登录就没必要停在这一页
  useEffect(() => {
    if (!loading && user) {
      router.replace(resolveNextUrl('/works'));
    }
  }, [loading, user, router]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }

    setSubmitting(true);
    try {
      await login({ username: username.trim(), password });
      router.replace(resolveNextUrl('/works'));
    } catch (err) {
      if (err instanceof ApiRequestError && err.isServerNotConfigured) {
        setError(err.message);
      } else if (err instanceof ApiRequestError) {
        setError(err.message || '登录失败，请稍后再试');
      } else {
        setError('登录失败，请稍后再试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 font-[family-name:var(--font-geist-sans)]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">登录</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">登录后即可把作品保存到云端</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-5 space-y-4 border border-gray-200 dark:border-gray-700"
        >
          <div>
            <label htmlFor="username" className="block text-sm font-medium mb-1">
              用户名
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="请输入用户名"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1">
              密码
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="请输入密码"
            />
          </div>

          {error && (
            <div className="text-xs sm:text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 whitespace-pre-wrap">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 px-4 text-sm sm:text-base rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white shadow-md transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? '登录中…' : '登录'}
          </button>

          <div className="flex items-center justify-between text-xs sm:text-sm text-gray-500 dark:text-gray-400 pt-1">
            <Link href="/register" className="text-blue-600 dark:text-blue-400 hover:underline">
              还没有账号？去注册
            </Link>
            <Link href="/" className="hover:underline">
              返回首页
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
