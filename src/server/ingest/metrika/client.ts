// Yandex Metrika Stat API v1. One query per counter and window: visits-table metrics only
// (ym:s:pageviews instead of ym:pv:*), so users and pageviews come from the same table.
// accuracy=full disables sampling. Up to 5 counters in parallel (docs/architecture/08-backend.md).

export interface MetrikaRow { date: string; countryName: string; countryIso: string | null; device: string; users: number; visits: number; pageviews: number; bounceRate: number; pageDepth: number }

export class MetrikaError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

export const METRIKA_METRICS = "ym:s:users,ym:s:visits,ym:s:pageviews,ym:s:bounceRate,ym:s:pageDepth";
export const METRIKA_DIMENSIONS = "ym:s:date,ym:s:regionCountry,ym:s:deviceCategory";

export class MetrikaClient {
  constructor(private o: { token: string; baseUrl?: string; fetchImpl?: typeof fetch }) {}

  async fetchCounter(counterId: string, from: string, to: string): Promise<{ rows: MetrikaRow[]; raw: unknown }> {
    const url = new URL(`${this.o.baseUrl ?? "https://api-metrika.yandex.net"}/stat/v1/data`);
    url.searchParams.set("ids", counterId);
    url.searchParams.set("metrics", METRIKA_METRICS);
    url.searchParams.set("dimensions", METRIKA_DIMENSIONS);
    url.searchParams.set("date1", from);
    url.searchParams.set("date2", to);
    url.searchParams.set("accuracy", "full");
    url.searchParams.set("limit", "100000");
    url.searchParams.set("lang", "en");
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(url, { headers: { Authorization: `OAuth ${this.o.token}` }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new MetrikaError(`Метрика недоступна: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new MetrikaError(res.status === 403 ? `Нет доступа к счётчику ${counterId} (403). Проверьте METRIKA_TOKEN и права.` : `Метрика вернула ${res.status}: ${text}`, res.status);
    }
    const raw = (await res.json()) as { data?: { dimensions: { name?: string; iso_name?: string; id?: string }[]; metrics: number[] }[] };
    const rows = (raw.data ?? []).map((r) => ({
      date: String(r.dimensions[0]?.name ?? ""),
      countryName: String(r.dimensions[1]?.name ?? ""),
      countryIso: r.dimensions[1]?.iso_name ?? null,
      device: String(r.dimensions[2]?.id ?? r.dimensions[2]?.name ?? ""),
      users: r.metrics[0] ?? 0, visits: r.metrics[1] ?? 0, pageviews: r.metrics[2] ?? 0,
      bounceRate: r.metrics[3] ?? 0, pageDepth: r.metrics[4] ?? 0,
    }));
    return { rows, raw };
  }
}
