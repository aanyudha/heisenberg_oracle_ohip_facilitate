import { loadConfig, applyConfig } from "./config.js";
import { openDb, migrate } from "./db.js";
const config = loadConfig();
applyConfig(config);
const db = await openDb(false, config);
try {
  await db.checkConnection();
  await migrate(db);
  console.log("Migrations applied");
} finally {
  await db.close();
}
