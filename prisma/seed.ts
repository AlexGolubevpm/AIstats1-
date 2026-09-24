import { createPrisma } from "../src/server/db";
import { seedReference } from "../src/server/seed/reference";

const db = createPrisma();
await seedReference(db);
console.log("reference data seeded");
await db.$disconnect();
