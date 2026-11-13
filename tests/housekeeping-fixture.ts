import { buildApp } from "../apps/api/src/app";
import { migrate } from "../apps/api/src/db";
import { seed } from "../apps/api/src/seed";
import { isolatedDatabase } from "./isolated-database";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
export type Auth = { cookie: string; csrf: string; id: string };
export async function housekeepingFixture(
  serveWeb = false,
  options?: Parameters<typeof buildApp>[1],
) {
  const isolated = await isolatedDatabase(),
    db = isolated.db;
  await migrate(db);
  await seed(db, "Isolated-HK-test-password!");
  const app = await buildApp(db, options);
  if (serveWeb) {
    await app.register(staticFiles, { root: resolve("dist/public") });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const originalOrigin = process.env.APP_ORIGIN;
  if (serveWeb) process.env.APP_ORIGIN = base;
  let counter = 1;
  async function login(email: string): Promise<Auth> {
    const r = await app.inject({
      method: "POST",
      url: "/api/login",
      remoteAddress: `127.1.${Math.floor(counter / 250)}.${(counter++ % 250) + 1}`,
      payload: { email, password: "Isolated-HK-test-password!" },
    });
    if (r.statusCode !== 200) throw Error(r.body);
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    const me = await app.inject({ url: "/api/me", headers: { cookie } });
    return { cookie, csrf: me.json().csrf, id: me.json().id };
  }
  const admin = await login("admin@demo.local");
  async function call(
    path: string,
    payload?: unknown,
    auth = admin,
    method = "PUT",
  ) {
    return app.inject({
      method: payload === undefined ? "GET" : (method as "PUT"),
      url: "/api/local-housekeeping/" + path,
      remoteAddress: `127.2.${Math.floor(counter / 250)}.${(counter++ % 250) + 1}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  async function ok(path: string, payload: unknown, auth = admin) {
    const r = await call(path, payload, auth);
    if (r.statusCode !== 200) throw Error(`${path}: ${r.body}`);
    return r.json();
  }
  async function staff(
    name: string,
    role: "supervisor" | "attendant",
    properties = ["demo-1"],
  ) {
    const email = `${name.toLowerCase().replaceAll(" ", ".")}@hk.test`;
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: {
        name,
        email,
        password: "Isolated-HK-test-password!",
        role: "housekeeping",
        hkRole: role,
        properties,
      },
    });
    if (r.statusCode !== 200) throw Error(r.body);
    return login(email);
  }
  async function roleCall(
    body: {
      userId: string;
      propertyId: string;
      jobRole: string;
      canManage?: boolean;
      department?: string;
    },
    auth = admin,
  ) {
    const { userId, ...payload } = body;
    return app.inject({
      method: "PATCH",
      url: "/api/admin/users/" + userId + "/housekeeping",
      remoteAddress: `127.3.${Math.floor(counter / 250)}.${(counter++ % 250) + 1}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload,
    });
  }
  async function roleOk(body: Parameters<typeof roleCall>[0], auth = admin) {
    const r = await roleCall(body, auth);
    if (r.statusCode !== 200) throw Error(r.body);
    return r.json();
  }
  const s1 = await staff("Supervisor One", "supervisor"),
    s2 = await staff("Supervisor Two", "supervisor");
  const a1 = await staff("Attendant One", "attendant"),
    a2 = await staff("Attendant Two", "attendant"),
    a3 = await staff("Attendant Three", "attendant");
  const noProperty = await staff("No Property", "attendant", []);
  const front = await login("frontoffice@demo.local"),
    other = await login("admin@other.local"),
    it = await login("it@demo.local");
  await ok("shifts", {
    propertyId: "demo-1",
    id: "AM",
    name: "Morning",
    startsAt: "07:00",
    endsAt: "15:00",
  });
  await ok("shifts", {
    propertyId: "demo-1",
    id: "PM",
    name: "Evening",
    startsAt: "15:00",
    endsAt: "23:00",
  });
  for (const [i, room] of ["201", "202", "203", "204", "205"].entries())
    await ok("directory", {
      propertyId: "demo-1",
      roomId: room,
      floor: i < 2 ? "West" : i < 4 ? "East" : "Annex",
      section: i % 2 ? "B" : "A",
      departureCredits: 2.5,
      stayoverCredits: 1.25,
      otherCredits: 0.5,
      validated: true,
    });
  const scope = (date = "2026-11-12", shiftId = "AM") => ({
    propertyId: "demo-1",
    date,
    shiftId,
  });
  async function plan(date = "2026-11-12", shiftId = "AM") {
    const s = scope(date, shiftId);
    for (const user of [s1, s2, a1, a2, a3])
      await ok("schedules", { ...s, userId: user.id, available: true });
    return s;
  }
  async function board(date = "2026-11-12", auth = admin, shiftId = "AM") {
    const r = await call(
      "board?" + new URLSearchParams(scope(date, shiftId)),
      undefined,
      auth,
    );
    if (r.statusCode !== 200) throw Error(r.body);
    return r.json();
  }
  return {
    db,
    app,
    base,
    admin,
    s1,
    s2,
    a1,
    a2,
    a3,
    noProperty,
    front,
    other,
    it,
    login,
    roleCall,
    roleOk,
    call,
    ok,
    plan,
    scope,
    board,
    async close() {
      await app.close();
      await isolated.close();
      if (serveWeb) {
        if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
        else process.env.APP_ORIGIN = originalOrigin;
      }
    },
  };
}
