// 用户存储：KV 里一条用户记录 + 一条用户名索引。

import { ApiError } from './http';
import type { Env } from './env';
import { getKV } from './store';
import { hashPassword, verifyPassword } from './crypto';

export interface UserRecord {
  id: string;
  /** 原始大小写，仅用于展示，登录一律按 username_lower 匹配 */
  username: string;
  username_lower: string;
  nickname: string;
  password_hash: string;
  password_salt: string;
  /** 微信打通预留，本次不写入 */
  wechat_openid?: string;
  wechat_unionid?: string;
  created_at: string;
  updated_at: string;
}

/** 对外暴露的用户信息，绝不包含口令字段 */
export interface PublicUser {
  id: string;
  username: string;
  nickname: string;
  wechat_bound: boolean;
  created_at: string;
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

const userKey = (id: string) => `user:id:${id}`;
const nameKey = (lower: string) => `user:name:${lower}`;
/** 微信打通预留索引，本次不写入 */
export const wechatKey = (openid: string) => `user:wx:${openid}`;

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    wechat_bound: Boolean(user.wechat_openid || user.wechat_unionid),
    created_at: user.created_at,
  };
}

export async function getUserById(env: Env, id: string): Promise<UserRecord | null> {
  const raw = await getKV(env).get(userKey(id), 'text');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserRecord;
  } catch {
    return null;
  }
}

export interface RegisterInput {
  username: string;
  password: string;
  nickname?: string;
}

export async function registerUser(env: Env, input: RegisterInput): Promise<UserRecord> {
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');

  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, 'INVALID_USERNAME', '用户名只能使用 3–32 位字母、数字、下划线或连字符');
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new ApiError(400, 'INVALID_PASSWORD', `密码长度需要 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位`);
  }

  const namespace = getKV(env);
  const lower = username.toLowerCase();
  const existing = await namespace.get(nameKey(lower), 'text');
  if (existing) {
    throw new ApiError(409, 'USERNAME_TAKEN', '这个用户名已经被注册了');
  }

  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    username_lower: lower,
    nickname: String(input.nickname ?? '').trim() || username,
    password_hash: hash,
    password_salt: salt,
    created_at: now,
    updated_at: now,
  };

  // 先占名字再写记录：并发注册同名时后写的会覆盖，但两个请求都拿不到同一个名字索引，
  // 个人自用场景下这点竞态可以接受。
  await namespace.put(nameKey(lower), user.id);
  await namespace.put(userKey(user.id), JSON.stringify(user));
  return user;
}

export async function authenticateUser(env: Env, username: string, password: string): Promise<UserRecord> {
  const namespace = getKV(env);
  const lower = String(username ?? '').trim().toLowerCase();
  const fakeDigest = { hash: '', salt: '' };

  // 用户名不存在时也跑一次口令校验，避免用响应时间探测用户名是否已注册
  const id = lower ? await namespace.get(nameKey(lower), 'text') : null;
  const user = id ? await getUserById(env, id) : null;
  const ok = user
    ? await verifyPassword(String(password ?? ''), { hash: user.password_hash, salt: user.password_salt })
    : await verifyPassword(String(password ?? ''), fakeDigest).then(() => false);

  if (!user || !ok) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
  }
  return user;
}

/** 微信打通时使用：按 openid 找用户，找不到就创建。本次未接入。 */
export async function findUserByWechat(env: Env, openid: string): Promise<UserRecord | null> {
  const id = await getKV(env).get(wechatKey(openid), 'text');
  return id ? getUserById(env, id) : null;
}
