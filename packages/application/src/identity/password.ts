import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:32768:8:1:${salt}:${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split(':');
  const salt = parts[4];
  const hash = parts[5];
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join(':') !== 'scrypt:32768:8:1' ||
    !salt ||
    !hash ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !/^[a-f0-9]{128}$/.test(hash)
  )
    return false;
  return timingSafeEqual(
    await derive(password, salt),
    Buffer.from(hash, 'hex'),
  );
}

export const secretHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const randomSecret = (prefix: string): string =>
  `${prefix}${randomBytes(32).toString('base64url')}`;
