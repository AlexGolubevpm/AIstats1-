// BullMQ queues. `asg` runs one job at a time (ADOK limits); `main` handles the rest.
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { JobData, JobName } from "./handlers";

let conn: IORedis | null = null;
export function redis(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"): IORedis {
  conn ??= new IORedis(url, { maxRetriesPerRequest: null });
  return conn;
}

const queues = new Map<string, Queue>();
export function queue(name: "asg" | "main"): Queue {
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection: redis(), defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500 } }));
  return queues.get(name)!;
}

export const queueOf = (job: JobName): "asg" | "main" => (job.startsWith("asg:") ? "asg" : "main");

/** Manual run from the UI (settings → integrations). */
export async function enqueue(job: JobName, data: JobData = {}): Promise<string> {
  const j = await queue(queueOf(job)).add(job, data);
  return j.id!;
}
