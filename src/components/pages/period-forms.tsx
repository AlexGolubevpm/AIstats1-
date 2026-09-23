"use client";
// Entering advertiser numbers, payments and disputes. Sheets, not modals: the periods
// table stays visible for reconciliation. docs/product/04-finance-and-deals.md.
import { useEffect, useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { fmtInt, fmtMoney, fmtPercent } from "@/lib/format";
import { calcPeriodAction, disputeAction, enterPeriodAction, paymentAction } from "@/server/actions/deals";

type Calc = Awaited<ReturnType<typeof calcPeriodAction>>;
const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[\s  $]/g, "").replace(",", ".")));
const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface PeriodDeal { id: string; basis: string; price: number; termsDays: number; sites: { id: string; domain: string }[] }
export interface PeriodValues { periodId?: string; from: string; to: string; siteId?: string | null; impsReported?: number | null; amountInvoiced?: number | null; invoiceNo?: string | null; dueAt?: string | null }

export function EnterPeriodButton({ deal, values, label = "Внести", variant = "primary" }: { deal: PeriodDeal; values: PeriodValues; label?: string; variant?: "primary" | "ghost" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const correction = Boolean(values.periodId);
  const draftKey = `deal-draft:${deal.id}:${values.periodId ?? values.from}`;
  const [f, setF] = useState(() => ({ from: values.from, to: values.to, siteId: values.siteId ?? "", imps: values.impsReported?.toString() ?? "",
    amount: values.amountInvoiced?.toFixed(2) ?? "", invoiceNo: values.invoiceNo ?? "", dueAt: values.dueAt ?? "", touched: Boolean(values.amountInvoiced) }));
  const [calc, setCalc] = useState<Calc>(null);
  const [override, setOverride] = useState(false);
  const [, start] = useTransition();

  useEffect(() => { // restore a draft saved before the page was closed
    if (!open || correction) return;
    try { const d = localStorage.getItem(draftKey); if (d) setF((x) => ({ ...x, ...JSON.parse(d) })); } catch { /* storage unavailable */ }
  }, [open, correction, draftKey]);
  useEffect(() => { if (open && !correction) try { localStorage.setItem(draftKey, JSON.stringify(f)); } catch { /* ignore */ } }, [f, open, correction, draftKey]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => start(async () => {
      const c = await calcPeriodAction(deal.id, f.from, f.to, num(f.imps), f.siteId || null);
      setCalc(c);
      if (c && !f.touched) setF((x) => ({ ...x, amount: Number(c.amount).toFixed(2) }));
    }), 300);
    return () => clearTimeout(t);
  }, [open, f.from, f.to, f.imps, f.siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const own = calc ? (deal.basis === "PER_1000_LOADS" ? calc.pageLoads : calc.impsOwn) : 0;
  const imps = num(f.imps);
  const disc = imps != null && own ? (own - imps) / own : null;
  const amount = num(f.amount) ?? 0;
  const calcAmount = calc ? Number(calc.amount) : 0;
  const differs = calc != null && Math.abs(amount - calcAmount) > 0.01;
  const forecast = calc ? Number(calc.forecast) : 0;
  const due = f.dueAt || addDays(f.to, deal.termsDays);
  const formula = deal.basis === "PER_1000_LOADS" ? `${fmtInt(calc?.pageLoads)} загрузок × $${deal.price} / 1000`
    : deal.basis === "CPM_ADVERTISER" ? `${fmtInt(imps)} × $${deal.price} / 1000` : deal.basis === "CPM_OWN" ? `${fmtInt(calc?.impsOwn)} × $${deal.price} / 1000`
    : deal.basis === "FLAT_DAILY" ? `${calc?.days ?? 0} дн. × $${deal.price}` : "флэт за период";

  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>{label}</Button>
      <Sheet open={open} onOpenChange={setOpen} title={correction ? "Исправить период" : "Внести данные за период"} width="max-w-2xl"
        description={correction ? "Создаётся новая версия, старая остаётся в истории." : "Цифры рекламодателя и счёт. Сумма раскладывается по дням пропорционально нашему счётчику."}>
        <ActionForm action={enterPeriodAction} submit={correction ? "Сохранить исправление" : "Сохранить — Выставлено"} cancel={() => setOpen(false)}
          onDone={() => { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } setOpen(false); }}>
          <input type="hidden" name="dealId" value={deal.id} />
          {correction && <input type="hidden" name="periodId" value={values.periodId} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="from" label="Начало периода"><Input type="date" name="from" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} required /></FormField>
            <FormField name="to" label="Конец периода"><Input type="date" name="to" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} required /></FormField>
          </div>
          {deal.sites.length > 1 && (
            <FormField name="siteId" label="Детализация" hint="Итого за период или по одному сайту (внесите остальные отдельно)">
              <Select name="siteId" value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
                <option value="">Итого за период</option>{deal.sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}
              </Select>
            </FormField>
          )}
          <div className="rounded-lg bg-surface-2 px-4 py-3 text-sm">
            <span className="text-muted">Наш счётчик: </span>
            <span className="num">{calc ? <>{fmtInt(calc.impsOwn)} показов · {fmtInt(calc.pageLoads)} загрузок · {calc.days} дн.</> : "считаем…"}</span>
          </div>
          <FormField name="impsReported" label="Показы рекламодателя"
            hint={disc != null ? <span className={cn(Math.abs(disc) > 0.1 && "text-warning")}>дискрепанси {fmtPercent(disc)} {Math.abs(disc) <= 0.1 ? "✓ в пределах ±10%" : "⚠ больше ±10%"}</span> : undefined}>
            <Input name="impsReported" inputMode="numeric" value={f.imps} onChange={(e) => setF({ ...f, imps: e.target.value })} className="num" required={deal.basis === "CPM_ADVERTISER"} />
          </FormField>
          <FormField name="amountInvoiced" label="Сумма к оплате, $" hint={calc ? `авторасчёт: ${formula} = ${fmtMoney(calcAmount)}` : undefined}>
            <Input name="amountInvoiced" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value, touched: true })} className="num" required />
          </FormField>
          {(differs || override) && (
            <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="override" value="1" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Сумма отличается от расчёта</label>
              {override && <FormField name="overrideReason" label="Причина"><Input name="overrideReason" required /></FormField>}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="invoiceNo" label="Номер счёта"><Input name="invoiceNo" value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} /></FormField>
            <FormField name="dueAt" label="Срок оплаты" hint={`из условий: net ${deal.termsDays}`}><Input type="date" name="dueAt" value={due} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></FormField>
          </div>
          {correction && <FormField name="reason" label="Причина исправления"><Input name="reason" required /></FormField>}
          {calc && (
            <p className="num text-sm text-muted">Предпросмотр: прогноз {fmtMoney(forecast)} → выставлено <span className="text-text">{fmtMoney(amount)}</span>
              {forecast > 0 && <> ({amount - forecast >= 0 ? "+" : ""}{fmtMoney(amount - forecast)}, {fmtPercent((amount - forecast) / forecast)})</>}</p>
          )}
        </ActionForm>
      </Sheet>
    </>
  );
}

export function PaymentButton({ dealId, periodId, invoiced, paid }: { dealId: string; periodId: string; invoiced: number; paid: number }) {
  const [open, setOpen] = useState(false);
  const rest = Math.max(0, invoiced - paid);
  const [amount, setAmount] = useState(rest.toFixed(2));
  const [remainder, setRemainder] = useState("");
  const short = (num(amount) ?? 0) + 0.0001 < rest;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Оплата</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Подтвердить оплату" description={`Выставлено ${fmtMoney(invoiced)}${paid ? ` · уже оплачено ${fmtMoney(paid)}` : ""}`}>
        <ActionForm action={paymentAction} submit="Сохранить — Подтверждено" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          <input type="hidden" name="dealId" value={dealId} /><input type="hidden" name="periodId" value={periodId} />
          <FormField name="amountPaid" label="Получено, $"><Input name="amountPaid" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="num" required /></FormField>
          <FormField name="paidAt" label="Дата"><Input type="date" name="paidAt" defaultValue={new Date().toISOString().slice(0, 10)} required /></FormField>
          {short && (
            <FormField name="remainder" label={`Остаток ${fmtMoney(rest - (num(amount) ?? 0))}`}>
              <div className="flex flex-col gap-1.5 text-sm">
                <label className="flex items-center gap-2"><input type="radio" name="remainder" value="open" checked={remainder === "open"} onChange={() => setRemainder("open")} /> Остаток ожидается</label>
                <label className="flex items-center gap-2"><input type="radio" name="remainder" value="write_off" checked={remainder === "write_off"} onChange={() => setRemainder("write_off")} /> Списать остаток</label>
              </div>
            </FormField>
          )}
          {short && remainder === "write_off" && <FormField name="writeOffReason" label="Причина списания"><Input name="writeOffReason" required /></FormField>}
          <FormField name="comment" label="Комментарий"><Textarea name="comment" rows={2} /></FormField>
        </ActionForm>
      </Sheet>
    </>
  );
}

export function DisputeButton({ dealId, periodId }: { dealId: string; periodId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Спор</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Пометить период как спорный" description="Сумма не войдёт в подтверждённую выручку, пока спор не решён.">
        <ActionForm action={disputeAction} submit="Пометить «спор»" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          <input type="hidden" name="dealId" value={dealId} /><input type="hidden" name="periodId" value={periodId} />
          <FormField name="reason" label="Причина"><Textarea name="reason" rows={3} required /></FormField>
        </ActionForm>
      </Sheet>
    </>
  );
}
