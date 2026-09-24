"use client";
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { fmtMoney } from "@/lib/format";
import { asgPayoutAction } from "@/server/actions/finance";

export function PayoutButton({ month, reported, label = "Внести выплату" }: { month: string; reported: number; label?: string }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(reported.toFixed(2));
  const diff = reported ? (Number(amount.replace(",", ".")) - reported) / reported : 0;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{label}</Button>
      <Sheet open={open} onOpenChange={setOpen} title={`Выплата AdSpyglass · ${month.slice(0, 7)}`}
        description="Сумма распределится по сайтам пропорционально отчётной выручке, месяц станет подтверждённым.">
        <ActionForm action={asgPayoutAction} submit="Сохранить — Подтверждено" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          <input type="hidden" name="month" value={month} />
          <div className="rounded-lg bg-surface-2 px-4 py-3 text-sm">Отчётная сумма за месяц: <span className="num font-medium">{fmtMoney(reported)}</span></div>
          <FormField name="amountReceived" label="Получено, $"
            hint={Number.isFinite(diff) && reported ? <span className={Math.abs(diff) > 0.02 ? "text-warning" : ""}>Расхождение {(diff * 100).toFixed(1)}%{Math.abs(diff) > 0.02 ? " — больше 2%" : ""}</span> : undefined}>
            <Input name="amountReceived" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required className="num" />
          </FormField>
          <FormField name="receivedAt" label="Дата получения">
            <Input type="date" name="receivedAt" defaultValue={new Date().toISOString().slice(0, 10)} required />
          </FormField>
          <FormField name="note" label="Комментарий"><Textarea name="note" rows={2} /></FormField>
        </ActionForm>
      </Sheet>
    </>
  );
}
