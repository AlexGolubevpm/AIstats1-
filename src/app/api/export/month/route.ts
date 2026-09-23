import { cookies } from "next/headers";
import { SESSION_COOKIE, validateSession } from "@/server/auth";
import { db } from "@/server/db";
import { monthReport } from "@/server/queries/month-report";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await validateSession(db, (await cookies()).get(SESSION_COOKIE)?.value))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const month = new URL(req.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return Response.json({ error: "month=YYYY-MM" }, { status: 400 });
  return new Response("﻿" + (await monthReport(month)), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="tubestat-${month}.csv"` },
  });
}
