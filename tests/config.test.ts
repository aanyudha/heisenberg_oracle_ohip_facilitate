import { describe, it, expect } from "vitest";
import { loadConfig } from "../apps/api/src/config";
describe("deployment configuration", () => {
  it("defaults to a single origin on port 3000 with persistent embedded demo", () => {
    expect(loadConfig({})).toMatchObject({
      port: 3000,
      host: "127.0.0.1",
      origin: "http://localhost:3000",
      mode: "demo",
      databasePath: "./data/demo",
      production: false,
    });
  });
  it("uses PORT for the default origin and accepts PostgreSQL without Docker", () => {
    expect(
      loadConfig({
        PORT: "3210",
        APP_MODE: "server",
        DATABASE_URL: "postgres://user:password@localhost/hotel",
      }),
    ).toMatchObject({
      port: 3210,
      origin: "http://localhost:3210",
      mode: "server",
    });
  });
  it("rejects invalid ports, origins, and ambiguous database settings", () => {
    for (const env of [
      { PORT: "0" },
      { PORT: "oops" },
      { PORT: "65536" },
      { APP_ORIGIN: "https://example.com/path" },
      { APP_ORIGIN: "javascript:alert(1)" },
      { LOCAL_DEMO: "false" },
      { DATABASE_URL: "sqlite://secret/path" },
      {
        DATABASE_URL: "postgres://user:secret@localhost/hotel",
        LOCAL_DEMO: "true",
      },
    ])
      expect(() => loadConfig(env)).toThrow();
  });
  it("validates production before database startup and never defaults to demo", () => {
    const valid = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:secret@db/hotel",
      APP_ORIGIN: "https://operations.example.com",
      COOKIE_SECURE: "true",
      ENCRYPTION_KEY: "a".repeat(64),
    };
    expect(loadConfig(valid)).toMatchObject({
      mode: "server",
      production: true,
    });
    for (const env of [
      { NODE_ENV: "production" },
      { ...valid, APP_MODE: "demo" },
      { ...valid, DATABASE_URL: "" },
      { ...valid, APP_ORIGIN: "http://localhost:3000" },
      { ...valid, COOKIE_SECURE: "false" },
      { ...valid, ENCRYPTION_KEY: "" },
    ])
      expect(() => loadConfig(env)).toThrow();
  });
  it("does not echo database credentials or invalid setting values", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "bad://admin:private-password@db" }),
    ).toThrow("DATABASE_URL must be a PostgreSQL connection URL");
    expect(() => loadConfig({ DEMO_PASSWORD: "private" })).toThrow(
      "Invalid configuration: DEMO_PASSWORD",
    );
  });
});
