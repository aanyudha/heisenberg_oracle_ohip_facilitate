import { housekeepingFixture } from "./housekeeping-fixture";
import { sql } from "../apps/api/src/db";
import type { Worksheet } from "@hospitality/contracts";

// Representative users/rooms are registered only in disposable test databases.
export async function usabilityFixture(serveWeb = false) {
  const f = await housekeepingFixture(serveWeb);
  const scope = f.scope("2026-11-17");
  const credentials = {
    manager: "hk.manager@usability.test",
    supervisor: "supervisor.one@hk.test",
    attendants: [
      "attendant.one@hk.test",
      "attendant.two@hk.test",
      "attendant.three@hk.test",
    ],
  };
  const password = "Isolated-HK-test-password!";
  async function create(
    name: string,
    email: string,
    hkRole: "manager" | "attendant",
  ) {
    const r = await f.app.inject({
      method: "POST",
      url: "/api/admin/users",
      remoteAddress: "127.14.0.1",
      headers: { cookie: f.admin.cookie, "x-csrf-token": f.admin.csrf },
      payload: {
        name,
        email,
        password,
        role: hkRole === "manager" ? "hotel_manager" : "housekeeping",
        hkRole,
        properties: ["demo-1"],
      },
    });
    if (r.statusCode !== 200) throw Error(r.body);
    return f.login(email);
  }
  const manager = await create("HK Manager", credentials.manager, "manager");
  const unscheduled = await create(
    "Unscheduled Room Attendant",
    "unscheduled@usability.test",
    "attendant",
  );
  const off = await create(
    "Off-shift Room Attendant",
    "off@usability.test",
    "attendant",
  );
  const inactive = await create(
    "Inactive Room Attendant",
    "inactive@usability.test",
    "attendant",
  );
  await f.db.orm.transaction(async (tx) => {
    for (const [user, name] of [
      [f.s1, "SPV HK 1"],
      [f.s2, "SPV HK 2"],
      [f.a1, "Attendant HK 1"],
      [f.a2, "Attendant HK 2"],
      [f.a3, "Attendant HK 3"],
    ] as const)
      await tx.execute(sql`UPDATE users SET name=${name} WHERE id=${user.id}`);
    await tx.execute(
      sql`INSERT INTO local_archives(tenant_id,kind,target) VALUES ('demo','users',${inactive.id})`,
    );
    await tx.execute(
      sql`DELETE FROM rooms WHERE tenant_id='demo' AND property_id='demo-1'`,
    );
    for (let i = 0; i < 274; i++) {
      const id = String(4101 + i),
        floor = i < 100 ? "02" : i < 200 ? "03" : "04",
        credit = ((i % 4) + 1) * 0.5;
      await tx.execute(
        sql`INSERT INTO rooms(id,tenant_id,property_id,status,attention) VALUES (${id},'demo','demo-1',${["dirty", "clean", "inspected"][i % 3]},'')`,
      );
      await tx.execute(
        sql`INSERT INTO housekeeping_room_directory(tenant_id,property_id,room_id,floor,section,departure_credits,stayover_credits,other_credits,validated_by,location_source,credits_configured) VALUES ('demo','demo-1',${id},${floor},'A',${credit},${credit},${credit},${f.admin.id},'local_validated',${i % 3 !== 0})`,
      );
      if (i % 2 === 0)
        await tx.execute(
          sql`INSERT INTO reservations(id,tenant_id,property_id,confirmation,guest_name,arrival,departure,status,room,source) VALUES (${"usability-" + id},'demo','demo-1',${"usability-" + id},'Synthetic fixture','2026-11-16',${i % 4 === 0 ? "2026-11-17" : "2026-11-19"},'InHouse',${id},'DEMO')`,
        );
    }
    await tx.execute(
      sql`INSERT INTO housekeeping_staff_schedules VALUES ('demo','demo-1',${scope.date},'AM',${off.id},false)`,
    );
  });
  for (const [id, name] of [
    ["AM", "Morning"],
    ["PM", "Evening"],
  ])
    await f.ok("shifts", {
      propertyId: "demo-1",
      id,
      name,
      startsAt: id === "AM" ? "07:00" : "15:00",
      endsAt: id === "AM" ? "15:00" : "23:00",
    });
  async function worksheet(auth = f.admin, shiftId = "AM"): Promise<Worksheet> {
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
    auth = f.admin,
    baseRevision?: string,
  ) {
    return f.call(
      "worksheet",
      {
        ...scope,
        baseRevision: baseRevision || (await worksheet(auth)).revision,
        mutationId: crypto.randomUUID(),
        operations,
      },
      auth,
    );
  }
  return {
    ...f,
    scope: () => scope,
    credentials,
    password,
    manager,
    unscheduled,
    off,
    inactive,
    worksheet,
    command,
  };
}
