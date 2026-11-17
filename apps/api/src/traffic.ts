import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppConfig } from "./config.js";

export class TrafficCounters {
  private sockets = new Map<Socket, { read: number; written: number }>();
  private inbound = 0;
  private outbound = 0;
  private http = 0;
  private elapsed = 0;
  private statuses = { success: 0, client: 0, server: 0 };
  private ws = { active: 0, messages: 0, connected: 0, disconnected: 0 };
  private ohip = new Map<number, { requests: number; errors: number }>();
  private last = {
    time: Date.now(),
    inbound: 0,
    outbound: 0,
    http: 0,
    elapsed: 0,
    messages: 0,
    connected: 0,
    disconnected: 0,
  };
  trackSocket(socket: Socket) {
    this.sockets.set(socket, { read: 0, written: 0 });
    socket.once("close", () => {
      this.measureSocket(socket);
      this.sockets.delete(socket);
    });
  }
  private measureSocket(socket: Socket) {
    const previous = this.sockets.get(socket);
    if (!previous) return;
    this.inbound += Math.max(0, socket.bytesRead - previous.read);
    this.outbound += Math.max(0, socket.bytesWritten - previous.written);
    previous.read = socket.bytesRead;
    previous.written = socket.bytesWritten;
  }
  recordHttp(status: number, duration: number) {
    this.http++;
    this.elapsed += duration;
    if (status >= 500) this.statuses.server++;
    else if (status >= 400) this.statuses.client++;
    else if (status >= 200 && status < 300) this.statuses.success++;
  }
  trackWebSocket(socket: WebSocket) {
    this.ws.active++;
    this.ws.connected++;
    socket.on("message", () => {
      this.ws.messages++;
    });
    const original = socket.send.bind(socket) as (...args: any[]) => void;
    socket.send = ((...args: any[]) => {
      original(...args);
      this.ws.messages++;
    }) as typeof socket.send;
    socket.once("close", () => {
      this.ws.active--;
      this.ws.disconnected++;
    });
  }
  recordOhip(error: boolean, now = Date.now()) {
    const second = Math.floor(now / 1000);
    this.prune(second);
    const bucket = this.ohip.get(second) || { requests: 0, errors: 0 };
    bucket.requests++;
    if (error) bucket.errors++;
    this.ohip.set(second, bucket);
  }
  private prune(second: number) {
    for (const key of this.ohip.keys())
      if (key <= second - 60) this.ohip.delete(key);
  }
  sample(now = Date.now()) {
    for (const socket of this.sockets.keys()) this.measureSocket(socket);
    this.prune(Math.floor(now / 1000));
    const seconds = Math.max(0.001, (now - this.last.time) / 1000);
    const requests = this.http - this.last.http;
    const result = {
      inbound: (this.inbound - this.last.inbound) / seconds,
      outbound: (this.outbound - this.last.outbound) / seconds,
      requests: requests / seconds,
      ...this.statuses,
      averageMs: requests ? (this.elapsed - this.last.elapsed) / requests : 0,
      wsActive: this.ws.active,
      wsMessages: (this.ws.messages - this.last.messages) / seconds,
      wsConnected: this.ws.connected - this.last.connected,
      wsDisconnected: this.ws.disconnected - this.last.disconnected,
      ohipRequests: [...this.ohip.values()].reduce((n, b) => n + b.requests, 0),
      ohipErrors: [...this.ohip.values()].reduce((n, b) => n + b.errors, 0),
    };
    this.last = {
      time: now,
      inbound: this.inbound,
      outbound: this.outbound,
      http: this.http,
      elapsed: this.elapsed,
      messages: this.ws.messages,
      connected: this.ws.connected,
      disconnected: this.ws.disconnected,
    };
    return result;
  }
  attach(app: FastifyInstance) {
    const onConnection = (socket: Socket) => this.trackSocket(socket);
    app.server.on("connection", onConnection);
    app.addHook("onResponse", async (_req, reply) => {
      this.recordHttp(reply.statusCode, reply.elapsedTime);
    });
    app.addHook("onClose", async () => {
      app.server.off("connection", onConnection);
      this.sockets.clear();
    });
  }
}
// Shared only within this Node process. Stores counters, never request payloads/URLs.
export const traffic = new TrafficCounters();
export const bytes = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(2)} MB/s`
    : n >= 1024
      ? `${(n / 1024).toFixed(2)} KB/s`
      : `${Math.round(n)} B/s`;
export function meterLines(
  s: ReturnType<TrafficCounters["sample"]>,
  integration: string,
) {
  const scale =
    2 ** Math.ceil(Math.log2(Math.max(1024, s.inbound, s.outbound)));
  const bar = (n: number) => {
    const full = Math.min(20, Math.round((20 * n) / scale));
    return "#".repeat(full) + ".".repeat(20 - full);
  };
  return [
    `APPLICATION SERVER TRAFFIC | bar full scale ${bytes(scale)} (auto)`,
    `IN  [${bar(s.inbound)}] ${bytes(s.inbound)} | OUT [${bar(s.outbound)}] ${bytes(s.outbound)}`,
    `HTTP ${s.requests.toFixed(1)} req/s | 2xx ${s.success} | 4xx ${s.client} | 5xx ${s.server} | avg ${s.averageMs.toFixed(1)} ms`,
    `WS ${s.wsActive} clients | ${s.wsMessages.toFixed(1)} msg/s | +${s.wsConnected}/-${s.wsDisconnected}`,
    `OHIP ${s.ohipRequests} req/min | ${s.ohipErrors} errors/min | ${integration}`,
  ];
}
export function startTrafficMeter(
  config: AppConfig,
  counters = traffic,
  integration: string | (() => string) = "state unavailable",
  output: NodeJS.WriteStream = process.stdout,
  errors: NodeJS.WriteStream = process.stderr,
) {
  // Docker/service/redirected output gets the startup JSON and normal error logs,
  // with no escape sequences or repeated idle lines.
  if (
    !config.trafficMeterEnabled ||
    config.startupDashboard === "off" ||
    config.mode === "docker" ||
    !output.isTTY ||
    !errors.isTTY
  )
    return () => {};
  const originalOutputWrite = output.write,
    originalErrorWrite = errors.write;
  const stdoutWrite = originalOutputWrite.bind(output),
    stderrWrite = originalErrorWrite.bind(errors);
  let displayed = false,
    stopped = false;
  const clear = () => {
    if (displayed) {
      stdoutWrite("\r\x1b[4A\x1b[J");
      displayed = false;
    }
  };
  // Remove the meter before normal output so errors cannot be overwritten by refresh.
  output.write = ((...args: any[]) => {
    clear();
    return (stdoutWrite as any)(...args);
  }) as typeof output.write;
  errors.write = ((...args: any[]) => {
    clear();
    return (stderrWrite as any)(...args);
  }) as typeof errors.write;
  const render = () => {
    if (stopped) return;
    clear();
    stdoutWrite(
      meterLines(
        counters.sample(),
        typeof integration === "function" ? integration() : integration,
      )
        .map((line) => line.slice(0, Math.max(1, (output.columns || 120) - 1)))
        .join("\n"),
    );
    displayed = true;
  };
  render();
  const timer = setInterval(render, config.trafficMeterInterval);
  timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clear();
    output.write = originalOutputWrite;
    errors.write = originalErrorWrite;
  };
}
