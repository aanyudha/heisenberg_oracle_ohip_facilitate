import {
  scrypt,
  randomBytes,
  createHash,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${((await derive(password, salt, 64)) as Buffer).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const calculated = (await derive(password, salt, 64)) as Buffer;
  const stored = Buffer.from(key, "hex");
  return (
    stored.length === calculated.length && timingSafeEqual(stored, calculated)
  );
}
function key() {
  if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY || ""))
    throw Error("ENCRYPTION_KEY must be 64 hex characters");
  return Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
}
export function encrypt(value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
export function decrypt(value: string) {
  const b = Buffer.from(value, "base64"),
    cipher = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  cipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(
      "utf8",
    ),
  );
}
