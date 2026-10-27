import { loadConfig } from "./config.js";
try {
  const config = loadConfig();
  const expected = {
    CHECK_DB_NAME: config.database?.database,
    CHECK_DB_USER: config.database?.user,
    CHECK_DB_PASSWORD: config.database?.password,
    CHECK_APP_PORT: String(config.port),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== undefined && process.env[key] !== value)
      throw Error(
        "Compose interpolation differs from root .env. Clear exported DB_NAME, DB_USER, DB_PASSWORD and APP_PORT in your shell, then retry.",
      );
  }
  console.log(
    `Configuration valid: ${config.name}, ${config.mode}, ${config.databaseType}, port ${config.port}`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Invalid configuration",
  );
  process.exitCode = 1;
}
