// Runtime configuration from environment variables (.env.example documents each one).
export function config(env: Record<string, string | undefined> = process.env) {
  const int = (v: string | undefined, def: number) => (v && /^\d+$/.test(v) ? Number(v) : def);
  return {
    asg: {
      baseUrl: env.ASG_API_URL ?? "https://api.adok.ai/api",
      email: (env.ASG_AUTH_EMAIL ?? "").trim(),
      token: (env.ASG_AUTH_TOKEN ?? "").trim(),
      minIntervalMs: int(env.ASG_MIN_INTERVAL_MS, 5_000),
      dailyBudget: int(env.ASG_DAILY_BUDGET, 300),
      restateDays: int(env.ASG_RESTATE_DAYS, 2),
      get configured() { return Boolean(this.email && this.token); },
    },
    metrika: {
      token: (env.METRIKA_TOKEN ?? "").trim(),
      get configured() { return Boolean(this.token); },
    },
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    appPassword: env.APP_PASSWORD ?? "",
    mcpToken: env.MCP_TOKEN ?? "",
    s3Configured: Boolean(env.S3_ENDPOINT && env.S3_BUCKET),
  };
}
export type Config = ReturnType<typeof config>;
