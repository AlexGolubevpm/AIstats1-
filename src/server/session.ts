import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, validateSession } from "@/server/auth";
import { db } from "@/server/db";

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Guards server components and actions: redirects to /login without a valid session. */
export async function requireSession(): Promise<void> {
  if (!(await validateSession(db, await sessionToken()))) redirect("/login");
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "unknown";
}
