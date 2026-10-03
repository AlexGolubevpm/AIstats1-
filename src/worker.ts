// Worker entry point (dist/worker.js in the image). Registers schedules and processes jobs.
import { Worker } from "bullmq";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { JOB_NAMES, SCHEDULES, runJob, type JobData, type JobName } from "@/server/jobs/handlers";
import { queue, redis } from "@/server/jobs/queue";
import { rawStoreFromEnv } from "@/server/ingest/raw-store";
import { seedReference } from "@/server/seed/reference";
import { evaluateAlerts } from "@/server/domain/alerts/rules";
import { revshareCosts } from "@/server/services/costs";
import { REFORECAST_DAYS, forecastDeals } from "@/server/services/deals";

const cfg = config();
const raw = rawStoreFromEnv();
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

await seedReference(db);
// Catch-up: every start (each deploy) re-applies the rules that otherwise wait for the night —
// fix-deal forecast (92 days), revshare cost from the current source shares (62 days) and the
// alert evaluation, so a rule change or a migration never leaves stale numbers until 04:45.
try {
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - (n - 1) * 86_400_000).toISOString().slice(0, 10);
  const deals = await forecastDeals(db, daysAgo(REFORECAST_DAYS), today);
  const costs = await revshareCosts(db, daysAgo(62), today);
  const sources = [cfg.asg.configured && "adspyglass", cfg.metrika.configured && "metrika"].filter(Boolean) as string[];
  const alerts = await evaluateAlerts({ db, asOf: today, configuredSources: sources });
  log("startup catch-up", { deals, costs, alerts: alerts.active });
} catch (e) { log("startup catch-up failed", { error: (e as Error).message }); }
for (const s of SCHEDULES) {
  await queue(s.queue).upsertJobScheduler(s.name, { pattern: s.pattern, tz: "UTC" }, { name: s.name, data: {} });
}
log("schedules registered", { schedules: SCHEDULES.map((s) => `${s.name} ${s.pattern}`) });

const handle = async (job: { id?: string; name: string; data: JobData }) => {
  if (!JOB_NAMES.includes(job.name as JobName)) throw new Error(`unknown job ${job.name}`);
  const res = await runJob(job.name as JobName, { db, cfg, raw }, job.data);
  log("job done", { jobId: job.id, job: job.name, ...res });
  return res;
};

const workers = [
  new Worker("asg", handle, { connection: redis(), concurrency: 1 }),
  new Worker("main", handle, { connection: redis(), concurrency: 2 }),
];
for (const w of workers) w.on("failed", (job, err) => log("job failed", { jobId: job?.id, job: job?.name, error: err.message }));

const stop = async () => {
  log("shutting down");
  await Promise.all(workers.map((w) => w.close()));
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
log("worker started");
