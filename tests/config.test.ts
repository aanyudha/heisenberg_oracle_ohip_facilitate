import { describe, it, expect } from "vitest";
import { loadConfig } from "../apps/api/src/config";
const base = {
  APP_MODE: "native",
  APP_URL: "http://localhost:3000",
  NODE_ENV: "development",
};
const pg = {
  ...base,
  DB_TYPE: "postgres",
  DB_USER: "hotel_admin",
  DB_PASSWORD: "Complex$:#@/% password",
};
describe("deployment configuration", () => {
  it("native defaults to persistent embedded without database credentials", () => {
    expect(loadConfig(base)).toMatchObject({
      mode: "native",
      port: 3000,
      databaseType: "embedded",
      database: undefined,
    });
    expect(loadConfig(base).databasePath).toMatch(/data[\\/]app.db$/);
  });
  it("uses separate PostgreSQL parameters without URL parsing or password mangling", () => {
    expect(
      loadConfig({
        ...pg,
        DB_HOST: "localhost",
        DB_PORT: "55432",
        DB_SSL: "true",
      }).database,
    ).toMatchObject({
      host: "localhost",
      port: 55432,
      user: "hotel_admin",
      password: pg.DB_PASSWORD,
      ssl: { rejectUnauthorized: true },
    });
  });
  it("Docker forces db:5432 and shares credentials", () => {
    expect(
      loadConfig(
        {
          ...pg,
          APP_MODE: "docker",
          DB_HOST: "external.example",
          DB_PORT: "9999",
        },
        "docker",
      ).database,
    ).toMatchObject({
      host: "db",
      port: 5432,
      user: pg.DB_USER,
      password: pg.DB_PASSWORD,
    });
  });
  it("rejects mismatched commands and Docker embedded", () => {
    expect(() => loadConfig({ ...pg, APP_MODE: "docker" }, "native")).toThrow(
      "does not match native startup",
    );
    expect(() => loadConfig(base, "docker")).toThrow(
      "does not match docker startup",
    );
    expect(() => loadConfig({ ...base, APP_MODE: "docker" }, "docker")).toThrow(
      "Docker requires DB_TYPE=postgres",
    );
  });
  it.each([
    { APP_MODE: "demo" },
    { DB_PASSWRD: "typo" },
    { DB_FILE: "file://invalid" },
    { DB_TYPE: "sqlite" },
    { APP_PORT: "" },
    { APP_PORT: "0" },
    { APP_PORT: "65536" },
    { APP_PORT: "1e3" },
    { DB_PORT: "3.4" },
    { DB_HOST: "host/path" },
    { DB_HOST: "" },
    { DB_NAME: "hotel; DROP DATABASE" },
    { DB_USER: "bad user" },
    { DB_SSL: "yes" },
    { ENCRYPTION_KEY: "weak-secret" },
    { APP_URL: "javascript:alert(1)" },
    { APP_URL: "http://localhost:3000/path" },
    { APP_URL: "http://user:secret@localhost:3000" },
    { DATABASE_URL: "postgres://user:secret@db/hotel" },
    { OHIP_ALLOWED_HOSTS: "*.example.com" },
    { POLL_INTERVAL_MS: "nonsense" },
    { OHIP_REQUEST_INTERVAL_MS: "0" },
  ])(
    "rejects malformed setting %j without displaying its value",
    (override) => {
      expect(() => loadConfig({ ...base, ...override })).toThrow();
    },
  );
  it.each([undefined, "", "   "])(
    "rejects empty PostgreSQL password",
    (password) => {
      expect(() => loadConfig({ ...pg, DB_PASSWORD: password })).toThrow(
        "non-empty DB_PASSWORD",
      );
    },
  );
  it("requires production encryption; allows local production embedded and protects public origins", () => {
    const production = {
      ...base,
      NODE_ENV: "production",
      ENCRYPTION_KEY: "a".repeat(64),
    };
    expect(loadConfig(production).production).toBe(true);
    expect(() => loadConfig({ ...production, ENCRYPTION_KEY: "" })).toThrow(
      "ENCRYPTION_KEY",
    );
    expect(() =>
      loadConfig({ ...production, APP_URL: "http://hotel.example" }),
    ).toThrow("HTTPS");
    expect(
      loadConfig({
        ...production,
        APP_URL: "https://hotel.example",
        COOKIE_SECURE: "true",
      }).origin,
    ).toBe("https://hotel.example");
    expect(() =>
      loadConfig({
        ...production,
        DEMO_SEED: "true",
        DEMO_PASSWORD: "long-test-password",
      }),
    ).toThrow("DEMO_SEED");
  });
  it("does not include passwords or secrets in validation errors", () => {
    const secret = "private-secret-value";
    try {
      loadConfig({ ...pg, ENCRYPTION_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(pg.DB_PASSWORD);
    }
  });
});
