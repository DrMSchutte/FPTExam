import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

// Field-level encryption for the few personal identifiers FPT Exam must hold
// (a learner's ID number for the Statement of Results). AES-256-GCM, one random
// nonce per value, key from DATA_ENCRYPTION_KEY (32+ bytes, any encoding) or -
// so a Repl works before that secret is set - derived from JWT_SECRET. Set
// DATA_ENCRYPTION_KEY before real learner data goes in; changing either secret
// afterwards makes existing values unreadable.

let key: Buffer | null = null;
function getKey(): Buffer {
  if (key) return key;
  const raw = process.env.DATA_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
  if (!raw) throw new Error("DATA_ENCRYPTION_KEY (or JWT_SECRET) must be set to store identity data.");
  key = Buffer.from(hkdfSync("sha256", raw, "fpt-exam", "field-encryption-v1", 32));
  return key;
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptField(stored: string): string {
  const [v, iv, enc, tag] = stored.split(".");
  if (v !== "v1") throw new Error("Unknown encrypted field version.");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64url")), decipher.final()]).toString("utf8");
}

// Stable one-way hash for duplicate detection without decrypting.
export function hashIdentifier(value: string): string {
  return createHash("sha256").update(`fpt-exam:${value.trim()}`).digest("hex");
}

export const last4 = (v: string) => v.replace(/\s/g, "").slice(-4);
