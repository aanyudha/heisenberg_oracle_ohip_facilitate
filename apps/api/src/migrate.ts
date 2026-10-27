import { openDb, migrate } from "./db.js";
const db = await openDb();
try {
  await db.checkConnection();
  await migrate(db);
  console.log("Migrations applied");
} finally {
  await db.close();
}
