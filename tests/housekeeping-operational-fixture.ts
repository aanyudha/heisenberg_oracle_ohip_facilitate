import { housekeepingFixture, type Auth } from "./housekeeping-fixture";
import { sql } from "../apps/api/src/db";

// Disposable test data only. Never imported by application/seed/runtime code.
export async function operationalFixture(serveWeb = false) {
  const f = await housekeepingFixture(serveWeb);
  const supervisors = [f.s1, f.s2],
    attendants = [f.a1, f.a2, f.a3];
  let address = 10;
  async function create(name: string, role: "supervisor" | "attendant") {
    const email = name.replaceAll(" ", "").toLowerCase() + "@ops.test";
    const r = await f.app.inject({
      method: "POST",
      url: "/api/admin/users",
      remoteAddress: `127.8.0.${address++}`,
      headers: { cookie: f.admin.cookie, "x-csrf-token": f.admin.csrf },
      payload: {
        name,
        email,
        password: "Isolated-HK-test-password!",
        role: "housekeeping",
        hkRole: role,
        properties: ["demo-1"],
      },
    });
    if (r.statusCode !== 200) throw Error(r.body);
    return f.login(email);
  }
  supervisors.push(await create("Supervisor Three", "supervisor"));
  for (let i = 4; i <= 12; i++)
    attendants.push(
      await create("Attendant " + String(i).padStart(2, "0"), "attendant"),
    );
  await f.db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM rooms WHERE tenant_id='demo' AND property_id='demo-1'`,
    );
    for (let i = 0; i < 120; i++) {
      const id = String(1001 + i),
        floor = ["Garden", "Tower", "Annex"][Math.floor(i / 40)],
        status = ["dirty", "clean", "inspected"][i % 3],
        credits = ((i % 5) + 1) * 0.5;
      await tx.execute(
        sql`INSERT INTO rooms(id,tenant_id,property_id,status,attention) VALUES (${id},'demo','demo-1',${status},${i % 11 === 0 ? "DND" : ""})`,
      );
      await tx.execute(
        sql`INSERT INTO housekeeping_room_directory(tenant_id,property_id,room_id,floor,section,departure_credits,stayover_credits,other_credits,validated_by,location_source,credits_configured) VALUES ('demo','demo-1',${id},${floor},'A',${credits},${credits},${credits},${f.admin.id},'local_validated',true)`,
      );
      if (i % 2 === 0)
        await tx.execute(
          sql`INSERT INTO reservations(id,tenant_id,property_id,confirmation,guest_name,arrival,departure,status,room,source) VALUES (${"fixture-" + id},'demo','demo-1',${"fixture-" + id},'Fixture only','2026-11-11',${i % 4 === 0 ? "2026-11-12" : "2026-11-14"},'InHouse',${id},'DEMO')`,
        );
    }
  });
  const scope = f.scope();
  await f.ok("roster", {
    ...scope,
    userIds: [...supervisors, ...attendants].map((a) => a.id),
  });
  async function worksheet(auth: Auth = f.admin, shiftId = "AM") {
    const r = await f.call(
      "worksheet?" + new URLSearchParams({ ...scope, shiftId }),
      undefined,
      auth,
    );
    if (r.statusCode !== 200) throw Error(r.body);
    return r.json();
  }
  async function command(
    operations: unknown[],
    auth: Auth = f.admin,
    revision?: string,
  ) {
    return f.call(
      "worksheet",
      {
        ...scope,
        baseRevision: revision || (await worksheet(auth)).revision,
        mutationId: crypto.randomUUID(),
        operations,
      },
      auth,
    );
  }
  return { ...f, supervisors, attendants, worksheet, command };
}
