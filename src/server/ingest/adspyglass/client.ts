// AdSpyglass (ADOK) report API client. ADOK blocks clients that send many requests, so this
// client is deliberately slow: one request at a time, a minimum interval between requests,
// a daily budget, and it refuses to continue after an auth failure or rate limit
// (docs/architecture/08-backend.md#asg-limits).

export interface AsgRow {
  name: string;
  hits?: number; impressions?: number; clicks?: number;
  broker_hits?: number; broker_income?: number; broker_clicks?: number;
  banner_view_rate?: number; fill_rate?: number; requests?: number;
  [k: string]: unknown;
}

export class AsgError extends Error {
  constructor(public kind: "auth" | "rate_limit" | "connection" | "server" | "bad_request" | "budget", message: string, public status?: number) {
    super(message);
  }
  /** Errors after which no more requests should be sent for a while. */
  get pausesQueue(): boolean { return this.kind === "auth" || this.kind === "rate_limit" || this.kind === "connection"; }
}

export interface AsgClientOptions {
  baseUrl: string;
  email: string;
  token: string;
  minIntervalMs?: number;
  /** Returns false when the daily budget is exhausted; called once per request. */
  takeBudget?: () => Promise<boolean>;
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ReportParams { from: string; to: string; groupBy: string; websiteId?: number; extra?: Record<string, string> }

export class AsgClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt: number | null = null;
  requests = 0;
  constructor(private o: AsgClientOptions) {}

  private get fetch() { return this.o.fetchImpl ?? fetch; }
  private sleep(ms: number) { return (this.o.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms); }
  private now() { return (this.o.now ?? Date.now)(); }

  /** Serialised: concurrent callers wait their turn. */
  report(p: ReportParams): Promise<AsgRow[]> {
    const run = this.queue.then(() => this.send(p), () => this.send(p));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(p: ReportParams): Promise<AsgRow[]> {
    const url = new URL(`${this.o.baseUrl.replace(/\/$/, "")}/report`);
    url.searchParams.set("from", p.from);
    url.searchParams.set("to", p.to);
    url.searchParams.set("group_by", p.groupBy);
    if (p.websiteId) url.searchParams.set("website_id", String(p.websiteId));
    for (const [k, v] of Object.entries(p.extra ?? {})) url.searchParams.set(k, v);

    const delays = this.o.retryDelaysMs ?? [60_000, 300_000];
    for (let attempt = 0; ; attempt++) {
      if (this.o.takeBudget && !(await this.o.takeBudget())) throw new AsgError("budget", "Дневной бюджет запросов к AdSpyglass исчерпан");
      if (this.lastAt != null) {
        const wait = this.lastAt + (this.o.minIntervalMs ?? 5_000) - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastAt = this.now();
      this.requests++;
      let res: Response;
      try {
        res = await this.fetch(url, {
          headers: { "X-Asg-Auth-Email": this.o.email, "X-Asg-Auth-Token": this.o.token, Accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        throw new AsgError("connection", `Соединение с AdSpyglass не удалось: ${(e as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const to = (res.headers.get("location") ?? "").split("?")[0];
        throw new AsgError("auth", `AdSpyglass не принял авторизацию (HTTP ${res.status}${to ? ` → ${to}` : ""}). Проверьте ASG_AUTH_EMAIL / ASG_AUTH_TOKEN.`, res.status);
      }
      if (res.status === 401 || res.status === 403) throw new AsgError("auth", `AdSpyglass вернул ${res.status}`, res.status);
      if (res.status === 429) throw new AsgError("rate_limit", "AdSpyglass ограничил частоту запросов (429)", 429);
      if (res.status >= 500) {
        if (attempt < delays.length) { await this.sleep(delays[attempt]); continue; }
        throw new AsgError("server", `AdSpyglass вернул ${res.status}`, res.status);
      }
      if (!res.ok) throw new AsgError("bad_request", `AdSpyglass вернул ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
      const body = await res.json();
      if (!Array.isArray(body)) throw new AsgError("bad_request", "AdSpyglass вернул не массив строк");
      return body as AsgRow[];
    }
  }
}
