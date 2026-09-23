// dist/seed.js in the image: idempotent reference data (countries, aliases, networks, cost sources).
// deploy.sh runs it after migrations, so the web app works even before the worker is enabled.
import { db } from "@/server/db";
import { seedReference } from "@/server/seed/reference";

await seedReference(db);
console.log("reference data ok");
await db.$disconnect();
