import { randomUUID } from "node:crypto";
import { openDb, migrate, sql, type Database } from "./db.js";
import { hashPassword } from "./security.js";
export async function seed(db: Database, password: string) {
  if (password.length < 12)
    throw Error("DEMO_PASSWORD requires at least 12 characters");
  const hash = await hashPassword(password);
  await db.orm.transaction(async (tx) => {
    const run = (q: Parameters<typeof tx.execute>[0]) => tx.execute(q);
    for (const tenant of ["demo", "other"]) {
      await run(
        sql`INSERT INTO tenants VALUES (${tenant},${tenant === "demo" ? "Meridian Hotel Group · DEMO" : "Other Group · DEMO"}) ON CONFLICT DO NOTHING`,
      );
      await run(
        sql`INSERT INTO organizations VALUES (${tenant + "-group"},${tenant},'Indonesia Collection') ON CONFLICT DO NOTHING`,
      );
      await run(
        sql`INSERT INTO branding_profiles VALUES (${tenant},'Meridian Operations','#17675d','','/favicon.svg') ON CONFLICT DO NOTHING`,
      );
      await run(
        sql`INSERT INTO app_instances VALUES (${tenant},${tenant},${tenant === "demo" ? "localhost" : "other.localhost"}) ON CONFLICT DO NOTHING`,
      );
      for (const [idx, name] of [
        "Meridian Jakarta",
        "Meridian Bali",
        "Meridian Bandung",
      ].entries()) {
        const p = tenant + "-" + (idx + 1);
        await run(
          sql`INSERT INTO properties(id,tenant_id,organization_id,name) VALUES (${p},${tenant},${tenant + "-group"},${name}) ON CONFLICT DO NOTHING`,
        );
        await run(
          sql`INSERT INTO connections(id,tenant_id,property_id,mode,environment,status) VALUES (${p},${tenant},${p},'demo','DEMO','demo') ON CONFLICT DO NOTHING`,
        );
        for (let i = 0; i < 16 - idx * 3; i++) {
          const businessDay = "(now() AT TIME ZONE 'Asia/Jakarta')::date";
          const id = "res-" + i,
            arrival =
              i < 7
                ? businessDay
                : i < 11
                  ? businessDay + " - 2"
                  : businessDay + " + 1",
            departure = i >= 7 && i < 11 ? businessDay : businessDay + " + 3";
          await run(
            sql`INSERT INTO reservations(id,tenant_id,property_id,confirmation,guest_name,arrival,departure,status,room,vip,source) VALUES (${id},${tenant},${p},${"DEMO-" + (81000 + idx * 100 + i)},${["Alex Morgan", "Jamie Lee", "Taylor Chen", "Sam Rivera", "Jordan Park", "Casey Wilson", "Avery Patel"][i % 7]},${sql.raw(arrival)},${sql.raw(departure)},${i >= 7 && i < 11 ? "InHouse" : "Reserved"},${String(201 + i)},${i % 5 === 0},'DEMO') ON CONFLICT DO NOTHING`,
          );
        }
        for (let i = 0; i < 6; i++)
          await run(
            sql`INSERT INTO rooms VALUES (${String(201 + i)},${tenant},${p},${i % 3 === 0 ? "dirty" : "clean"},${i % 3 === 0 ? "Inspection required" : ""},now()) ON CONFLICT DO NOTHING`,
          );
        for (const [i, title] of [
          "Prepare VIP welcome amenities",
          "Inspect room 201 before arrival",
          "Confirm airport transfer",
        ].entries())
          await run(
            sql`INSERT INTO tasks(id,tenant_id,property_id,title,priority) VALUES (${p + "-task-" + i},${tenant},${p},${title},${i === 0 ? "high" : "normal"}) ON CONFLICT DO NOTHING`,
          );
      }
      for (const [suffix, role] of [
        ["admin", "group_admin"],
        ["frontoffice", "front_office"],
        ["housekeeping", "housekeeping"],
        ["it", "it"],
        ["manager", "hotel_manager"],
        ["platform", "platform_admin"],
      ] as const) {
        const uid = tenant + "-" + suffix;
        await run(
          sql`INSERT INTO users(id,email,name,password_hash,developer) VALUES (${uid},${suffix + "@" + tenant + ".local"},${suffix},${hash},${suffix === "platform"}) ON CONFLICT DO NOTHING`,
        );
        await run(
          sql`INSERT INTO memberships VALUES (${tenant},${uid},${role}) ON CONFLICT DO NOTHING`,
        );
        for (const n of [
          "1",
          ...(["admin", "platform", "it"].includes(suffix) ? ["2", "3"] : []),
        ])
          await run(
            sql`INSERT INTO property_grants VALUES (${tenant},${uid},${tenant + "-" + n}) ON CONFLICT DO NOTHING`,
          );
      }
    }
    await run(
      sql`INSERT INTO retry_jobs(id,tenant_id,property_id,operation,idempotency_key,state,last_error) VALUES (${randomUUID()},'demo','demo-2','reservation_poll','demo-recovery','queued','DEMO simulated timeout') ON CONFLICT DO NOTHING`,
    );
  });
}
if (process.argv[1]?.endsWith("seed.ts")||process.argv[1]?.endsWith("seed.js")) {
  if (process.env.NODE_ENV === "production"||process.env.APP_MODE==='server')
    throw Error("Demo seed disabled in production");
  const db = await openDb();
  try {
    await migrate(db);
    await seed(db, process.env.DEMO_PASSWORD || "");
    console.log("DEMO seeded. Login: admin@demo.local with DEMO_PASSWORD");
  } finally {
    await db.close();
  }
}
