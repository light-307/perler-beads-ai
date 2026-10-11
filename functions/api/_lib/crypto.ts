// 口令哈希与自签会话 token。
//
// 会话 token 用 HS256 自签（不做数据库存储），密钥来自环境变量 AUTH_SECRET；
// 口令用 PBKDF2-SHA256 加随机盐，绝不明文落盘。

const encoder = new TextEncoder();

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BYTES = 32;
const PBKDF2_SALT_BYTES = 16;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

function utf8ToBase64Url(text: string): string {
  return toBase64Url(encoder.encode(text));
}

/** 定长比较，避免通过响应时间区分「口令错」与「用户名错」。 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export interface PasswordDigest {
  hash: string;
  salt: string;
}

async function deriveBits(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    PBKDF2_HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<PasswordDigest> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const bits = await deriveBits(password, salt);
  return { hash: bytesToBase64(bits), salt: bytesToBase64(salt) };
}

export async function verifyPassword(password: string, digest: PasswordDigest): Promise<boolean> {
  try {
    const salt = base64ToBytes(digest.salt);
    const bits = await deriveBits(password, salt);
    return constantTimeEqual(bits, base64ToBytes(digest.hash));
  } catch {
    return false;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface SessionClaims {
  /** 用户 id */
  sub: string;
  /** 用户名，便于排查问题时直接看出身份 */
  name: string;
  iat: number;
  exp: number;
}

export async function signSessionToken(claims: SessionClaims, secret: string): Promise<string> {
  const header = utf8ToBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = utf8ToBase64Url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return `${data}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(signature) as unknown as BufferSource,
      encoder.encode(`${header}.${payload}`)
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as SessionClaims;
    if (!claims?.sub || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
