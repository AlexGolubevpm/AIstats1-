// «Подключить через Яндекс»: remembers a one-time state in a cookie and sends the owner to Yandex's consent page
// with the app's callback as redirect_uri (ADR 0018). Needs a session (proxy.ts) and a public https address (APP_URL).
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { withBase } from "@/lib/base-path";
import { SESSION_COOKIE, sessionCookieOptions, validateSession } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { authorizeUrl } from "@/server/ingest/metrika/oauth";
import { getMetrikaConnection, metrikaCallbackUrl } from "@/server/services/metrika-connection";

export const dynamic = "force-dynamic";
export const STATE_COOKIE = "ts_metrika_state";

export async function GET(req: Request) {
  const jar = await cookies();
  if (!(await validateSession(db, jar.get(SESSION_COOKIE)?.value))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const cfg = config();
  const back = (q: string) => NextResponse.redirect(new URL(`${withBase("/settings/integrations")}?${q}#metrika`, req.url));
  const callback = metrikaCallbackUrl(cfg);
  if (!callback) return back("metrika_error=" + encodeURIComponent("Переход через Яндекс доступен только по https-адресу приложения; вставьте код руками"));
  const conn = await getMetrikaConnection(db, cfg).catch(() => null);
  if (!conn) return back("metrika_error=" + encodeURIComponent("Сначала сохраните ID и секрет приложения"));
  const state = randomBytes(16).toString("base64url");
  jar.set(STATE_COOKIE, state, { ...sessionCookieOptions(), maxAge: 600 });
  return NextResponse.redirect(authorizeUrl(conn.clientId, { redirectUri: callback, state }));
}
