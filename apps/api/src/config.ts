import { config as dotenv } from "dotenv";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import { projectRoot } from "./paths.js";

const port = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/);
const hostname = z
  .string()
  .max(253)
  .refine(
    (v) =>
      isIP(v) !== 0 ||
      v
        .split(".")
        .every((label) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
        ),
  );
const schema = z.strictObject({
  APP_MODE: z.enum(["native", "docker"]),
  APP_PORT: port.default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  APP_NAME: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((v) =>
      [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
    )
    .default("Hotel Operations"),
  APP_URL: z.string().min(1),
  DB_TYPE: z.enum(["embedded", "postgres"]).default("embedded"),
  DB_FILE: z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) => [...v].every((c) => c.charCodeAt(0) >= 32) && !v.includes("://"),
    )
    .default("./data/app.db"),
  DB_HOST: hostname.default("localhost"),
  DB_PORT: port.default(5432),
  DB_NAME: identifier.default("hotel_operations"),
  DB_USER: identifier.optional(),
  DB_PASSWORD: z
    .string()
    .max(1024)
    .refine((v) => ![...v].some((c) => [0, 10, 13].includes(c.charCodeAt(0))))
    .optional(),
  DB_SSL: z.enum(["true", "false"]).default("false"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  DEMO_SEED: z.enum(["true", "false"]).default("false"),
  DEMO_PASSWORD: z.string().min(12).max(256).optional(),
  OHIP_ACCESS_MODE: z.literal("read_only").default("read_only"),
  OHIP_MUTATIONS_ENABLED: z.literal("false").default("false"),
  OHIP_ALLOWED_HOSTS: z.string().default(""),
  POLL_INTERVAL_MS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(30000).max(86400000))
    .default(60000),
  OHIP_REQUEST_INTERVAL_MS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(250).max(60000))
    .default(250),
});
export type RuntimeMode = "native" | "docker";
export function runtimeMode(): RuntimeMode {
  return existsSync("/.dockerenv") ? "docker" : "native";
}
export function loadConfig(
  environment?: NodeJS.ProcessEnv,
  runtime: RuntimeMode = runtimeMode(),
) {
  if (!environment) {
    const path = resolve(projectRoot, ".env");
    if (!existsSync(path))
      throw Error(
        "Missing root .env. Copy .env.example to .env, choose APP_MODE and configure secrets before startup.",
      );
    const result = dotenv({ path, quiet: true });
    if (result.error)
      throw Error("Cannot read root .env; check file permissions.");
    // Root .env is authoritative, independent of cwd and inherited shell values.
    environment = result.parsed || {};
  }
  for (const key of [
    "DATABASE_URL",
    "LOCAL_DEMO",
    "LOCAL_DB_PATH",
    "PORT",
    "APP_ORIGIN",
    "HOST",
    "POSTGRES_PASSWORD",
  ])
    if (environment[key])
      throw Error(
        `Legacy setting ${key} is no longer supported; migrate to the variables in .env.example.`,
      );
  const input = { ...environment };
  for (const key of ["ENCRYPTION_KEY", "DEMO_PASSWORD", "DB_USER"])
    if (input[key] === "") delete input[key];
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw Error(
      "Invalid configuration: " +
        [
          ...new Set(
            parsed.error.issues.map((i) =>
              i.code === "unrecognized_keys"
                ? i.keys.join(", ")
                : i.path.join("."),
            ),
          ),
        ].join(", ") +
        ". Check .env.example for valid formats (ports: 1-65535; identifiers: letters, digits, underscores or hyphens).",
    );
  const env = parsed.data;
  if (env.APP_MODE !== runtime)
    throw Error(
      `APP_MODE=${env.APP_MODE} does not match ${runtime} startup. Stop the other deployment and set APP_MODE=${runtime} in root .env before running ${runtime === "native" ? "npm start" : "docker compose up --build -d"}.`,
    );
  if (env.APP_MODE === "docker" && env.DB_TYPE !== "postgres")
    throw Error(
      "Docker requires DB_TYPE=postgres; native supports embedded or postgres.",
    );
  if (env.DB_TYPE === "postgres" && (!env.DB_USER || !env.DB_PASSWORD?.trim()))
    throw Error(
      "PostgreSQL requires DB_USER and a non-empty DB_PASSWORD in root .env.",
    );
  if (
    env.DB_TYPE === "postgres" &&
    /^(change[-_ ]?me|replace[-_ ].*|your[-_ ].*|password|local-development-only)$/i.test(
      env.DB_PASSWORD!,
    )
  )
    throw Error(
      "DB_PASSWORD must be a unique secret, not an example placeholder.",
    );
  let url: URL;
  try {
    url = new URL(env.APP_URL);
  } catch {
    throw Error(
      "APP_URL must be a canonical HTTP(S) origin, for example http://localhost:3000.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== env.APP_URL
  )
    throw Error(
      "APP_URL must be a canonical HTTP(S) origin without credentials, path or trailing slash.",
    );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (env.NODE_ENV === "production" && !env.ENCRYPTION_KEY)
    throw Error(
      "Production requires ENCRYPTION_KEY: generate 32 random bytes as 64 hexadecimal characters.",
    );
  if (
    env.NODE_ENV === "production" &&
    !local &&
    (url.protocol !== "https:" || env.COOKIE_SECURE !== "true")
  )
    throw Error(
      "Production public APP_URL requires HTTPS and COOKIE_SECURE=true.",
    );
  if (env.COOKIE_SECURE === "true" && url.protocol !== "https:")
    throw Error("COOKIE_SECURE=true requires an HTTPS APP_URL.");
  if (
    env.DEMO_SEED === "true" &&
    (env.NODE_ENV === "production" || !env.DEMO_PASSWORD)
  )
    throw Error(
      "DEMO_SEED=true requires NODE_ENV=development/test and an explicit DEMO_PASSWORD of at least 12 characters.",
    );
  if (
    env.OHIP_ALLOWED_HOSTS &&
    env.OHIP_ALLOWED_HOSTS.split(",").some(
      (h) => !hostname.safeParse(h.trim()).success || isIP(h.trim()),
    )
  )
    throw Error(
      "OHIP_ALLOWED_HOSTS must contain exact gateway hostnames, separated by commas.",
    );
  return {
    name: env.APP_NAME,
    mode: env.APP_MODE,
    port: env.APP_PORT,
    host: env.APP_MODE === "docker" ? "0.0.0.0" : "127.0.0.1",
    origin: env.APP_URL,
    production: env.NODE_ENV === "production",
    databaseType: env.DB_TYPE,
    databasePath: resolve(projectRoot, env.DB_FILE),
    database:
      env.DB_TYPE === "postgres"
        ? {
            host: env.APP_MODE === "docker" ? "db" : env.DB_HOST,
            port: env.APP_MODE === "docker" ? 5432 : env.DB_PORT,
            database: env.DB_NAME,
            user: env.DB_USER!,
            password: env.DB_PASSWORD!,
            ssl:
              env.DB_SSL === "true"
                ? { rejectUnauthorized: true as const }
                : (false as const),
            connectionTimeoutMillis: 5000,
          }
        : undefined,
    cookieSecure: env.COOKIE_SECURE,
    demoSeed: env.DEMO_SEED === "true",
    demoPassword: env.DEMO_PASSWORD,
    encryptionKey: env.ENCRYPTION_KEY,
    allowedHosts: env.OHIP_ALLOWED_HOSTS,
    ohipAccessMode: env.OHIP_ACCESS_MODE,
    ohipMutationsEnabled: env.OHIP_MUTATIONS_ENABLED,
    pollInterval: env.POLL_INTERVAL_MS,
    requestInterval: env.OHIP_REQUEST_INTERVAL_MS,
  };
}
export type AppConfig = ReturnType<typeof loadConfig>;
export function applyConfig(config: AppConfig) {
  process.env.APP_ORIGIN = config.origin;
  process.env.COOKIE_SECURE = config.cookieSecure;
  process.env.ENCRYPTION_KEY = config.encryptionKey || "";
  process.env.OHIP_ALLOWED_HOSTS = config.allowedHosts;
  process.env.OHIP_ACCESS_MODE = config.ohipAccessMode;
  process.env.OHIP_MUTATIONS_ENABLED = config.ohipMutationsEnabled;
  process.env.POLL_INTERVAL_MS = String(config.pollInterval);
  process.env.OHIP_REQUEST_INTERVAL_MS = String(config.requestInterval);
}
