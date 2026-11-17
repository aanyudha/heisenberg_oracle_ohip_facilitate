import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { once } from "node:events";
import {
  TrafficCounters,
  bytes,
  meterLines,
  startTrafficMeter,
} from "../apps/api/src/traffic";
import { loadConfig } from "../apps/api/src/config";

afterEach(() => vi.useRealTimers());
const config = loadConfig({
  APP_MODE: "native",
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
});
describe("application server traffic", () => {
  it("shows idle zero counters, defined auto scale and correct units", () => {
    const counters = new TrafficCounters();
    const lines = meterLines(counters.sample(), "no configured OHIP").join(
      "\n",
    );
    expect(lines).toContain("[....................] 0 B/s");
    expect(lines).toContain("HTTP 0.0 req/s");
    expect(lines).toContain("WS 0 clients");
    expect(lines).toContain("full scale 1.00 KB/s (auto)");
    expect(bytes(1024)).toBe("1.00 KB/s");
    expect(bytes(1024 * 1024)).toBe("1.00 MB/s");
  });
  it("measures real HTTP and WebSocket bytes once at accepted sockets, including socket closure", async () => {
    const counters = new TrafficCounters();
    const app = Fastify();
    counters.attach(app);
    await app.register(websocket);
    app.get("/", async () => ({ fixture: "x".repeat(4096) }));
    app.get("/error", async (_req, reply) =>
      reply.code(500).send({ error: "fixture" }),
    );
    app.get("/ws", { websocket: true }, (socket) => {
      counters.trackWebSocket(socket);
      socket.on("message", (data) => socket.send(data));
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws");
    try {
      await once(socket, "open");
      const message = once(socket, "message");
      socket.send("counter-fixture");
      await message;
      await (await fetch(origin)).text();
      await (await fetch(origin + "/error")).text();
      const measured = counters.sample(Date.now() + 1000);
      expect(measured.inbound).toBeGreaterThan(0);
      expect(measured.outbound).toBeGreaterThan(4096 / 3);
      expect(measured.success).toBe(1);
      expect(measured.server).toBe(1);
      expect(measured.wsActive).toBe(1);
      expect(measured.wsMessages).toBeGreaterThan(0);
      expect(measured.wsConnected).toBe(1);
      const closed = once(socket, "close");
      socket.close();
      await closed;
      await new Promise((r) => setTimeout(r, 30));
      expect(counters.sample(Date.now() + 2000)).toMatchObject({
        wsActive: 0,
        wsDisconnected: 1,
      });
    } finally {
      socket.terminate();
      await app.close();
    }
  });
  it("keeps only 60 seconds of OHIP request/error counters and excludes payloads", () => {
    const c = new TrafficCounters();
    c.recordOhip(false, 100000);
    c.recordOhip(true, 100000);
    expect(c.sample(100000)).toMatchObject({ ohipRequests: 2, ohipErrors: 1 });
    expect(c.sample(161000)).toMatchObject({ ohipRequests: 0, ohipErrors: 0 });
    expect(JSON.stringify(c.sample())).not.toMatch(/password|token|guest|url/i);
  });
  it("uses no animated writes for redirected output, disabled dashboard or Docker", () => {
    const output = new PassThrough();
    const writes: string[] = [];
    output.on("data", (data) => writes.push(data.toString()));
    const out = output as unknown as typeof process.stdout;
    startTrafficMeter(config, new TrafficCounters(), "fixture", out, out)();
    Object.assign(output, { isTTY: true, columns: 120 });
    startTrafficMeter(
      { ...config, mode: "docker" },
      new TrafficCounters(),
      "fixture",
      out,
      out,
    )();
    startTrafficMeter(
      { ...config, startupDashboard: "off" },
      new TrafficCounters(),
      "fixture",
      out,
      out,
    )();
    startTrafficMeter(
      { ...config, trafficMeterEnabled: false },
      new TrafficCounters(),
      "fixture",
      out,
      out,
    )();
    expect(writes).toEqual([]);
  });
  it("refreshes in place, leaves errors readable and restores streams/timers on shutdown", () => {
    vi.useFakeTimers();
    const output = new PassThrough(),
      errors = new PassThrough();
    Object.assign(output, { isTTY: true, columns: 160 });
    Object.assign(errors, { isTTY: true });
    const writes: string[] = [];
    output.on("data", (data) => writes.push(data.toString()));
    errors.on("data", (data) => writes.push(data.toString()));
    const stop = startTrafficMeter(
      config,
      new TrafficCounters(),
      "fixture",
      output as unknown as typeof process.stdout,
      errors as unknown as typeof process.stderr,
    );
    expect(writes.join("")).toContain("APPLICATION SERVER TRAFFIC");
    vi.advanceTimersByTime(1000);
    errors.write("Readable fixture error\n");
    expect(writes.at(-1)).toBe("Readable fixture error\n");
    expect(writes.join("")).not.toContain("\x1b[2J");
    stop();
    const length = writes.length;
    vi.advanceTimersByTime(3000);
    expect(writes.length).toBe(length);
    expect(vi.getTimerCount()).toBe(0);
  });
});
