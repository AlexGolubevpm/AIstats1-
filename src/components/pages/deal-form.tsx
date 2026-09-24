"use client";
// New deal / edit terms. "За 1000 загрузок" is the default: the only model where we own the denominator.
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { saveDealAction } from "@/server/actions/deals";

export interface DealFormSite { id: string; domain: string; zones: { id: string; name: string }[] }
export interface DealFormValues {
  id?: string; title?: string; advertiser?: string; format?: string; paymentBasis?: string; price?: string; siteIds?: string[]; zoneBySite?: Record<string, string | null>;
  geoScope?: string; geoExclude?: boolean; startsAt?: string; endsAt?: string | null; billingPeriod?: string; paymentTermsDays?: number;
  counterSource?: string; billedVia?: string; notes?: string | null; hasPeriods?: boolean;
}

const FORMATS = [["POPUNDER", "Popunder"], ["BANNER", "Баннер"], ["NATIVE", "Нативка"], ["SLIDER", "Слайдер"], ["OUTSTREAM", "Outstream"], ["INVIDEO", "In-video"], ["INPAGEPUSH", "In-page push"], ["OTHER", "Другое"]];
const BASIS = [["PER_1000_LOADS", "За 1000 загрузок"], ["CPM_ADVERTISER", "CPM по счётчику рекламодателя"], ["CPM_OWN", "CPM по нашему счётчику"], ["FLAT_DAILY", "Флэт в сутки"], ["FLAT_PERIOD", "Флэт за период"]];

export function DealFormButton({ sites, advertisers, values = {}, label, variant = "primary" }: {
  sites: DealFormSite[]; advertisers: string[]; values?: DealFormValues; label: string; variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(values.siteIds ?? []));
  const [q, setQ] = useState("");
  const [basis, setBasis] = useState(values.paymentBasis ?? "PER_1000_LOADS");
  const edit = Boolean(values.id);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>{label}</Button>
      <Sheet open={open} onOpenChange={setOpen} title={edit ? "Условия дила" : "Новый дил"} width="max-w-2xl"
        description="Сделки вне аукциона AdSpyglass: прямой код рекламодателя, спонсорский баннер, флэт за место.">
        <ActionForm action={saveDealAction} submit={edit ? "Сохранить условия" : "Создать дил"} onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          {edit && <input type="hidden" name="id" value={values.id} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="advertiser" label="Рекламодатель">
              <Input name="advertiser" list="advertisers" defaultValue={values.advertiser} required autoComplete="off" />
            </FormField>
            <datalist id="advertisers">{advertisers.map((a) => <option key={a} value={a} />)}</datalist>
            <FormField name="title" label="Название"><Input name="title" defaultValue={values.title} required placeholder="Спонсорский баннер в шапке" /></FormField>
            <FormField name="format" label="Формат">
              <Select name="format" defaultValue={values.format ?? "BANNER"}>{FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            </FormField>
            <FormField name="billedVia" label="Как платит" hint="Через AdSpyglass — выручка уже в own_deals, не задваиваем">
              <Select name="billedVia" defaultValue={values.billedVia ?? "DIRECT"}><option value="DIRECT">Напрямую нам</option><option value="VIA_ASG">Через AdSpyglass</option></Select>
            </FormField>
            <FormField name="paymentBasis" label="Модель оплаты">
              <Select name="paymentBasis" value={basis} onChange={(e) => setBasis(e.target.value)}>{BASIS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            </FormField>
            <FormField name="price" label={basis.startsWith("FLAT") ? "Цена, $ (2 знака)" : "Цена за 1000, $ (до 5 знаков)"}>
              <Input name="price" inputMode="decimal" defaultValue={values.price} required className="num" />
            </FormField>
          </div>

          <FormField name="siteIds" label={`Сайты · выбрано ${picked.size}`}>
            <div className="rounded-lg border border-border">
              <Input placeholder="Поиск по домену" value={q} onChange={(e) => setQ(e.target.value)} className="rounded-b-none border-0 border-b" />
              <div className="max-h-56 overflow-y-auto p-1">
                {sites.filter((s) => s.domain.includes(q.toLowerCase()) || picked.has(s.id)).map((s) => (
                  <div key={s.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-hover">
                    <input type="checkbox" name="siteIds" value={s.id} id={`site-${s.id}`} checked={picked.has(s.id)}
                      onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(s.id) : n.delete(s.id); setPicked(n); }} />
                    <label htmlFor={`site-${s.id}`} className="flex-1 font-mono text-xs">{s.domain}</label>
                    {picked.has(s.id) && s.zones.length > 0 && (
                      <select name={`zone_${s.id}`} defaultValue={values.zoneBySite?.[s.id] ?? ""} className="h-7 rounded border border-border bg-surface px-1 text-xs">
                        <option value="">все зоны</option>{s.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </FormField>

          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <FormField name="geoScope" label="Гео-скоуп" hint="Коды ISO через запятую или T1/T2/T3; пусто — все страны">
              <Input name="geoScope" defaultValue={values.geoScope} placeholder="JP, KR или T1" className="font-mono" />
            </FormField>
            <label className="flex items-center gap-2 self-center pt-4 text-sm"><input type="checkbox" name="geoExclude" value="1" defaultChecked={values.geoExclude} /> все, кроме</label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="startsAt" label="Начало"><Input type="date" name="startsAt" defaultValue={values.startsAt ?? new Date().toISOString().slice(0, 10)} required /></FormField>
            <FormField name="endsAt" label="Конец" hint="Пусто — бессрочно"><Input type="date" name="endsAt" defaultValue={values.endsAt ?? ""} /></FormField>
            <FormField name="billingPeriod" label="Период счёта">
              <Select name="billingPeriod" defaultValue={values.billingPeriod ?? "MONTH"}><option value="MONTH">Месяц</option><option value="WEEK">Неделя</option><option value="TERM">Весь срок</option></Select>
            </FormField>
            <FormField name="paymentTermsDays" label="Срок оплаты, дней"><Input name="paymentTermsDays" inputMode="numeric" defaultValue={values.paymentTermsDays ?? 30} className="num" /></FormField>
            <FormField name="counterSource" label="Наш счётчик">
              <Select name="counterSource" defaultValue={values.counterSource ?? "ASG_ZONE"}>
                <option value="ASG_ZONE">Зона AdSpyglass</option><option value="METRIKA">Просмотры Метрики</option><option value="MANUAL">Вручную</option>
              </Select>
            </FormField>
          </div>
          <FormField name="notes" label="Заметки, контакт"><Textarea name="notes" rows={2} defaultValue={values.notes ?? ""} /></FormField>
          {edit && values.hasPeriods && (
            <FormField name="reason" label="Причина изменения" hint="По дилу уже внесены периоды: изменение цены или модели попадёт в историю">
              <Input name="reason" />
            </FormField>
          )}
        </ActionForm>
      </Sheet>
    </>
  );
}
