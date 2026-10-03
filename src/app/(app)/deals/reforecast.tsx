"use client";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { reforecastDealsAction } from "@/server/actions/deals";

/** Recomputes every deal's forecast for the last 92 days — no need to re-save deals or wait for the night. */
export function ReforecastButton() {
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <Button variant="secondary" disabled={pending} onClick={() => start(async () => {
      const r = await reforecastDealsAction();
      r.error ? toast(r.error, "error") : toast(r.message ?? "Готово");
    })}>{pending ? "Считаю…" : "Пересчитать прогноз"}</Button>
  );
}
