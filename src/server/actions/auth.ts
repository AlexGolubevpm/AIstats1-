"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, SESSION_DAYS, login, logout } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { clientIp, sessionToken } from "@/server/session";

export async function loginAction(_: unknown, form: FormData): Promise<{ error?: string }> {
  const r = await login(db, String(form.get("password") ?? ""), await clientIp(), config().appPassword);
  if (!r.ok) return { error: r.error };
  (await cookies()).set(SESSION_COOKIE, r.token, {
    httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "1", path: "/", maxAge: SESSION_DAYS * 86_400,
  });
  const next = String(form.get("next") ?? "/");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction(): Promise<void> {
  await logout(db, await sessionToken());
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
