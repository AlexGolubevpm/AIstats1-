import { redirect } from "next/navigation";

/** «Рекомендации» became «Гипотезы» (ADR 0013); old links keep working. */
export default async function Recommendations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v) q.set(k, v);
  redirect(`/hypotheses${q.size ? `?${q}` : ""}`);
}
