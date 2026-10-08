// The path the app is served under ("" at the root, "/admin" on xhubtraffic.com/admin). Fixed at build
// time by BASE_PATH (next.config.ts). <Link>, redirect() and revalidatePath() add it on their own; a plain
// <a href>, the session cookie path and URLs shown to people go through withBase().
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

/** `/api/export` → `/admin/api/export` when the app lives under /admin; unchanged at the root. */
export function withBase(path: string): string {
  if (!BASE_PATH) return path;
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return `${BASE_PATH}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Cookie path: the app's base path, so a session on xhubtraffic.com/admin is not sent to the rest of the domain. */
export const cookiePath = () => BASE_PATH || "/";
