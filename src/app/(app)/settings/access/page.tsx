import { headers } from "next/headers";
import { Section } from "@/components/ui/card";
import { fmtAgo, fmtDate } from "@/lib/format";
import { mcpTokenInfo } from "@/server/auth";
import { db } from "@/server/db";
import { McpToken, PasswordForm } from "./client";

export default async function Access() {
  const [info, h] = await Promise.all([mcpTokenInfo(db), headers()]);
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "tubestat";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return (
    <>
      <Section title="Пароль приложения" sub="После смены все сессии, кроме текущей, сбрасываются"><PasswordForm /></Section>
      <Section title="MCP-токен" sub={info ? `Выпущен ${fmtDate(info.createdAt)} · последнее использование: ${info.lastUsedAt ? fmtAgo(info.lastUsedAt) : "не использовался"}` : "Токен не выпущен"}>
        <McpToken exists={Boolean(info)} url={`${proto}://${host}/api/mcp`} />
      </Section>
    </>
  );
}
