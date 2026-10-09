// Yandex sends the owner back here with ?code=…&state=… (ADR 0018). The state must match the cookie set by /start;
// the code is exchanged for tokens and the owner lands on the Metrika block with the counters ready to match.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { withBase } from "@/lib/base-path";
import { SESSION_COOKIE, validateSession } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { connectMetrika, metrikaCallbackUrl } from "@/server/services/metrika-connection";
import { STATE_COOKIE } from "../start/route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const jar = await cookies();
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`${withBase("/settings/integrations")}?${q}#metrika`, req.url));
  if (!(await validateSession(db, jar.get(SESSION_COOKIE)?.value))) {
    return NextResponse.redirect(new URL(`${withBase("/login")}?next=${encodeURIComponent(withBase("/settings/integrations") + "#metrika")}`, req.url));
  }
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state"), denied = url.searchParams.get("error");
  if (denied) return back("metrika_error=" + encodeURIComponent(`Яндекс не выдал доступ: ${url.searchParams.get("error_description") ?? denied}`));
  if (!code || !state || !expected || state !== expected) return back("metrika_error=" + encodeURIComponent("Ссылка устарела или открыта не из приложения — нажмите «Подключить через Яндекс» ещё раз"));
  try {
    const cfg = config();
    await connectMetrika(db, cfg, code, fetch, new Date(), metrikaCallbackUrl(cfg));
    return back("connected=1");
  } catch (e) {
    return back("metrika_error=" + encodeURIComponent((e as Error).message));
  }
}
