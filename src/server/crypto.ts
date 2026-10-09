// Secrets the owner enters in the UI (Metrika OAuth, ADR 0018) are stored in AppSetting encrypted
// with APP_SECRET — a random key the deploy writes into the server .env once (deploy/apply-env.sh).
// AES-256-GCM; the blob is `v1:<iv>:<tag>:<ciphertext>` in base64url, so a leaked database dump
// shows nothing without the server's .env.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { RuleError } from "@/server/domain/errors";

const key = (secret: string) => createHash("sha256").update(secret).digest();
export const NO_SECRET = "APP_SECRET не задан на сервере: нужен деплой, он создаст ключ сам (deploy/apply-env.sh)";
export const BAD_KEY = "Ключ приложения (APP_SECRET) сменился — сохранённые секреты не читаются, подключите Метрику заново";

export function encryptSecret(plain: string, secret: string): string {
  if (!secret) throw new RuleError("secret", NO_SECRET);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSecret(blob: string, secret: string): string {
  if (!secret) throw new RuleError("secret", NO_SECRET);
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new RuleError("secret", BAD_KEY);
  try {
    const d = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new RuleError("secret", BAD_KEY);
  }
}
