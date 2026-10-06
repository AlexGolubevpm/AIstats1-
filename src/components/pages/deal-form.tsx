"use client";
// New deal / edit terms. "За 1000 загрузок" is the default: the only model where we own the denominator.
import { useEffect, useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { saveDealAction } from "@/server/actions/deals";

export interface DealFormSite { id: string; domain: string; zones: { id: string; name: string }[] }
export interface DealFormValues {
  id?: string; title?: string; advertiser?: string; paymentBasis?: string; price?: string; siteIds?: string[]; zoneBySite?: Record<string, string | null>;
  geoScope?: string; geoExclude?: boolean; startsAt?: string; endsAt?: string | null; billingPeriod?: string; paymentTermsDays?: number;
  counterSource?: string; billedVia?: string; notes?: string | null; hasPeriods?: boolean;
  /** Places on sites as `siteId|placementSlug`. */
  places?: string[];
}
const BASIS = [["PER_1000_LOADS", "За 1000 загрузок"], ["CPM_ADVERTISER", "CPM по счётчику рекламодателя"], ["CPM_OWN", "CPM по нашему счётчику"], ["FLAT_DAILY", "Флэт в сутки"], ["FLAT_PERIOD", "Флэт за период"]];

export function DealFormButton({ sites, advertisers, placements = [], values = {}, label, variant = "primary", autoOpen = false }: {
  sites: DealFormSite[]; advertisers: string[]; placements?: { slug: string; title: string }[]; values?: DealFormValues; label: string; variant?: "primary" | "secondary";
  /** Opens the form at once (a link from the Formats grid with a place pre-selected). */
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (autoOpen) setOpen(true); }, [autoOpen]);
  const [picked, setPicked] = useState<Set<string>>(new Set([...(values.siteIds ?? []), ...(values.places ?? []).map((k) => k.split("|")[0])]));
  const [places, setPlaces] = useState<Set<string>>(new Set(values.places ?? []));
  const togglePlace = (key: string, on: boolean) => {
    const n = new Set(places); on ? n.add(key) : n.delete(key); setPlaces(n);
    if (on) { const s = new Set(picked); s.add(key.split("|")[0]); setPicked(s); }
  };
  const toggleSite = (id: string, on: boolean) => {
    const s = new Set(picked); on ? s.add(id) : s.delete(id); setPicked(s);
    if (!on) setPlaces(new Set([...places].filter((k) => !k.startsWith(`${id}|`))));
  };
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

          <FormField name="place" label={`Места на сайтах · сайтов ${picked.size}, мест ${places.size}`}
            hint="Отметьте места, которые занимает дил; они закрасятся во вкладке «Форматы». Сайт без мест — дил считается, но места не занимает">
            <div className="rounded-lg border border-border">
              <Input placeholder="Поиск по домену" value={q} onChange={(e) => setQ(e.target.value)} className="rounded-b-none border-0 border-b" />
              <div className="max-h-80 overflow-y-auto p-1">
                {sites.filter((s) => s.domain.includes(q.toLowerCase()) || picked.has(s.id)).map((s) => (
                  <div key={s.id} className="rounded px-2 py-1 hover:bg-surface-hover">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" name="siteIds" value={s.id} id={`site-${s.id}`} checked={picked.has(s.id)} onChange={(e) => toggleSite(s.id, e.target.checked)} />
                      <label htmlFor={`site-${s.id}`} className="flex-1 font-mono text-xs">{s.domain}</label>
                      {picked.has(s.id) && s.zones.length > 0 && (
                        <select name={`zone_${s.id}`} defaultValue={values.zoneBySite?.[s.id] ?? ""} className="h-7 rounded border border-border bg-surface px-1 text-xs" aria-label={`Зона-счётчик ${s.domain}`}>
                          <option value="">все зоны</option>{s.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                        </select>
                      )}
                    </div>
                    {placements.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1 pl-5">
                        {placements.map((p) => {
                          const key = `${s.id}|${p.slug}`, on = places.has(key);
                          return (
                            <label key={p.slug} className={`cursor-pointer select-none rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:border-border-strong"}`}>
                              <input type="checkbox" name="place" value={key} checked={on} onChange={(e) => togglePlace(key, e.target.checked)} className="sr-only" aria-label={`${p.title} на ${s.domain}`} />
                              {p.title}
                            </label>
                          );
                        })}
                      </div>
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
