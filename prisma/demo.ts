// npm run db:demo — loads demo data and derives costs, deal forecasts, periods and alerts.
import { createPrisma } from "../src/server/db";
import { loadDemo } from "../src/server/seed/load-demo";

const db = createPrisma();
const r = await loadDemo(db, { days: Number(process.env.DEMO_DAYS ?? 60) });
console.log(`demo data: ${r.sites} sites × ${r.days} days`);
await db.$disconnect();
