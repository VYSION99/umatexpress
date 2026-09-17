export const PASSWORD_ITERATIONS = 100_000;

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Invalid encoded credential.");
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function derivePassword(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt.slice().buffer as ArrayBuffer, iterations }, key, 256);
  return new Uint8Array(bits);
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt);
  return { hash: bytesToBase64(hash), salt: bytesToBase64(salt), iterations: PASSWORD_ITERATIONS };
}

export async function verifyPassword(password: string, hash: string, salt: string, iterations = PASSWORD_ITERATIONS) {
  try {
    const saltBytes = base64ToBytes(salt);
    const expected = base64ToBytes(hash);
    if (saltBytes.length !== 16 || expected.length !== 32 || !Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
    const actual = await derivePassword(password, saltBytes, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validPasswordRecord(hash: unknown, salt: unknown, iterations: unknown) {
  try {
    const rounds = Number(iterations);
    return typeof hash === "string" && typeof salt === "string" && base64ToBytes(hash).length === 32 && base64ToBytes(salt).length === 16 && Number.isInteger(rounds) && rounds >= 10_000 && rounds <= 1_000_000;
  } catch {
    return false;
  }
}
