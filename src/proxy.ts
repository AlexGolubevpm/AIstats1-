// Next 16 proxy (former middleware): pages and APIs need a session cookie. The session itself
// is validated against the database in the (app) layout and in route handlers.
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/api/health", "/api/mcp"];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (req.cookies.get("ts_session")) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
