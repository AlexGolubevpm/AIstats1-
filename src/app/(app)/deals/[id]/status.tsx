"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { dealStatusAction, deleteDealAction } from "@/server/actions/deals";

export function DealStatusButtons({ id, status, title }: { id: string; status: string; title: string }) {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<"end" | "delete" | null>(null);
  const toast = useToast();
  const run = (fn: () => Promise<{ ok?: boolean; error?: string; message?: string }>) => start(async () => {
    const r = await fn();
    if (r?.error) toast(r.error, "error"); else if (r?.message) toast(r.message);
  });
  return (
    <>
      {status === "ACTIVE" && <Button size="sm" disabled={pending} onClick={() => run(() => dealStatusAction(id, "PAUSED"))}>Пауза</Button>}
      {(status === "PAUSED" || status === "DRAFT") && <Button size="sm" disabled={pending} onClick={() => run(() => dealStatusAction(id, "ACTIVE"))}>Активировать</Button>}
      {status !== "ENDED" && status !== "DRAFT" && <Button size="sm" disabled={pending} onClick={() => setConfirm("end")}>Завершить</Button>}
      {status === "DRAFT" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm("delete")}>Удалить</Button>}
      <Confirm open={confirm === "end"} onOpenChange={(v) => !v && setConfirm(null)} title={`Завершить дил «${title}»?`}
        body="Прогноз перестанет считаться после даты конца. Внесённые периоды и оплаты останутся." confirmLabel="Завершить" onConfirm={() => run(() => dealStatusAction(id, "ENDED"))} />
      <Confirm open={confirm === "delete"} onOpenChange={(v) => !v && setConfirm(null)} title={`Удалить черновик «${title}»?`} destructive
        body="Действие необратимо." confirmLabel="Удалить" onConfirm={() => run(() => deleteDealAction(id))} />
    </>
  );
}
