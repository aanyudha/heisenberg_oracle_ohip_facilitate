import { loadConfig, applyConfig } from "./config.js";
import { openDb, migrate } from "./db.js";
import { acquireDeploymentLock } from "./deployment-lock.js";
const config = loadConfig();
applyConfig(config);
const release = await acquireDeploymentLock();
const db = await openDb(false, config).catch(async (error) => {
  await release();
  throw error;
});
try {
  await db.checkConnection();
  console.log(
    JSON.stringify({ event: "database_migration", ...(await migrate(db)) }),
  );
} finally {
  await db.close();
  await release();
}
