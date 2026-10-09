// Yandex OAuth for Metrika (ADR 0018). Authorization-code flow without a registered callback: the owner
// opens `authorizeUrl`, Yandex shows a confirmation code on oauth.yandex.ru/verification_code, the code
// is pasted into Settings → Integrations and exchanged here for an access + refresh token.
import { MetrikaError } from "./client";

export const YANDEX_OAUTH = "https://oauth.yandex.ru";
export interface OAuthApp { clientId: string; clientSecret: string }
export interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresAt: Date }

export function authorizeUrl(clientId: string, base = YANDEX_OAUTH): string {
  const u = new URL(`${base}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("force_confirm", "yes");
  return u.toString();
}

const ERRORS: Record<string, string> = {
  bad_verification_code: "Код не подошёл: проверьте, что скопирован целиком",
  invalid_grant: "Код устарел или уже использован — получите новый",
  invalid_client: "ID или секрет приложения неверны",
  unauthorized_client: "Приложению не выдан доступ к Метрике — проверьте права в oauth.yandex.ru",
};

async function tokenRequest(body: Record<string, string>, app: OAuthApp, fetchImpl: typeof fetch, base: string, now: Date): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/token`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams(body).toString(),
    });
  } catch (e) {
    throw new MetrikaError(`Яндекс OAuth недоступен: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    const code = json.error ?? `HTTP ${res.status}`;
    throw new MetrikaError(ERRORS[code] ?? `Яндекс OAuth: ${code}${json.error_description ? ` — ${json.error_description}` : ""}`, res.status);
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null, expiresAt: new Date(now.getTime() + (json.expires_in ?? 365 * 86_400) * 1000) };
}

/** The confirmation code the owner pasted → tokens. */
export function exchangeCode(app: OAuthApp, code: string, fetchImpl: typeof fetch = fetch, base = YANDEX_OAUTH, now = new Date()): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: "authorization_code", code: code.trim() }, app, fetchImpl, base, now);
}

/** A new access token from the refresh token (Yandex tokens live about a year). */
export function refreshTokens(app: OAuthApp, refreshToken: string, fetchImpl: typeof fetch = fetch, base = YANDEX_OAUTH, now = new Date()): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, app, fetchImpl, base, now);
}
