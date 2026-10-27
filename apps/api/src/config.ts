import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_MODE: z.enum(["demo", "server"]).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: z.string().optional(),
  LOCAL_DEMO: z.enum(["true", "false"]).optional(),
  LOCAL_DB_PATH: z.string().min(1).default("./data/demo"),
  APP_ORIGIN: z.string().optional(),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  ENCRYPTION_KEY: z.string().optional(),
  DEMO_PASSWORD: z.string().min(12).max(256).optional(),
});
export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const input = Object.fromEntries(
    Object.entries(environment).filter(([, v]) => v !== ""),
  );
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw Error(
      "Invalid configuration: " +
        [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(
          ", ",
        ),
    );
  const env = parsed.data;
  const production = env.NODE_ENV === "production";
  const mode = env.APP_MODE || (production ? "server" : "demo");
  if (production && mode !== "server")
    throw Error("Production cannot run APP_MODE=demo");
  if (env.DATABASE_URL) {
    let valid = false;
    try {
      const url = new URL(env.DATABASE_URL);
      valid =
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        !!url.hostname &&
        url.pathname.length > 1;
    } catch {
      /* Never echo credentials. */
    }
    if (!valid) throw Error("DATABASE_URL must be a PostgreSQL connection URL");
    if (env.LOCAL_DEMO === "true")
      throw Error("Choose DATABASE_URL or LOCAL_DEMO=true, not both");
  }
  if (!env.DATABASE_URL && (mode === "server" || env.LOCAL_DEMO === "false"))
    throw Error(
      "Server mode requires DATABASE_URL; omit it for the local embedded demo",
    );
  const origin = env.APP_ORIGIN || `http://localhost:${env.PORT}`;
  let canonical: URL;
  try {
    canonical = new URL(origin);
  } catch {
    throw Error("APP_ORIGIN must be an HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(canonical.protocol) ||
    canonical.username ||
    canonical.password ||
    canonical.origin !== origin
  )
    throw Error("APP_ORIGIN must be a canonical HTTP(S) origin without a path");
  if (env.ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY))
    throw Error("ENCRYPTION_KEY must be 64 hex characters");
  if (
    production &&
    (env.COOKIE_SECURE !== "true" ||
      canonical.protocol !== "https:" ||
      !env.ENCRYPTION_KEY)
  )
    throw Error(
      "Production requires HTTPS APP_ORIGIN, COOKIE_SECURE=true, and ENCRYPTION_KEY",
    );
  return {
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    databasePath: env.LOCAL_DB_PATH,
    origin,
    mode,
    production,
    cookieSecure: env.COOKIE_SECURE,
    demoPassword: env.DEMO_PASSWORD,
  };
}
