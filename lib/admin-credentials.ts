import { isTursoConfigured, rowsToObjects, turso } from "@/lib/turso";

export const DEFAULT_ADMIN_PASSWORD = "Admin@12345";
const ITERATIONS = 210_000;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function derivePassword(password: string, salt: Uint8Array, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt.slice().buffer as ArrayBuffer, iterations }, key, 256);
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

async function ensureAdminCredentialsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS admin_credentials (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

async function storedCredential(email: string) {
  if (!isTursoConfigured()) return null;
  await ensureAdminCredentialsTable();
  return rowsToObjects(await turso(
    "SELECT password_hash, password_salt, password_iterations FROM admin_credentials WHERE email = ? LIMIT 1",
    [email.toLowerCase()],
  ))[0] || null;
}

function bootstrapPassword() {
  const configured = process.env.ADMIN_PASSWORD || "";
  return configured.length >= 10 && !configured.startsWith("replace-with") ? configured : DEFAULT_ADMIN_PASSWORD;
}

export async function adminMustChangePassword(email: string) {
  return !(await storedCredential(email));
}

export async function verifyAdminPassword(email: string, password: string) {
  const stored = await storedCredential(email);
  if (!stored) {
    const left = new TextEncoder().encode(password);
    const right = new TextEncoder().encode(bootstrapPassword());
    return constantTimeEqual(left, right);
  }
  const salt = base64ToBytes(String(stored.password_salt));
  const expected = base64ToBytes(String(stored.password_hash));
  const actual = await derivePassword(password, salt, Number(stored.password_iterations || ITERATIONS));
  return constantTimeEqual(actual, expected);
}

export async function changeAdminPassword(email: string, currentPassword: string, newPassword: string) {
  if (!isTursoConfigured()) throw new Error("Configure Turso before changing the administrator password.");
  if (!await verifyAdminPassword(email, currentPassword)) throw new Error("The current password is incorrect.");
  if (newPassword.length < 12 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
    throw new Error("Use at least 12 characters with uppercase, lowercase, a number, and a symbol.");
  }
  if (newPassword === DEFAULT_ADMIN_PASSWORD || newPassword === currentPassword) throw new Error("Choose a new password that is different from the current password.");
  await ensureAdminCredentialsTable();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(newPassword, salt);
  await turso(
    "INSERT INTO admin_credentials (email, password_hash, password_salt, password_iterations, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt, password_iterations = excluded.password_iterations, updated_at = excluded.updated_at",
    [email.toLowerCase(), bytesToBase64(hash), bytesToBase64(salt), ITERATIONS, new Date().toISOString()],
  );
}
