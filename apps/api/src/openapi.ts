import type { FastifyInstance } from "fastify";
const text = { type: "string", maxLength: 100 } as const;
const day = { type: "string", format: "date" } as const;
const propertyId = { ...text, minLength: 1 };
const page = { type: "integer", minimum: 1, default: 1 };
const limit = { type: "integer", minimum: 1, maximum: 100, default: 25 };
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const query = object({ propertyId, page, limit });
const bodies: Record<string, unknown> = {
  "POST /api/switch-tenant": object({ tenantId: text }, ["tenantId"]),
  "POST /api/admin/tenants": object(
    { name: text, hostname: { type: "string", maxLength: 253 } },
    ["name", "hostname"],
  ),
  "PATCH /api/admin/users/:id": object(
    {
      role: {
        enum: [
          "platform_admin",
          "group_admin",
          "hotel_manager",
          "front_office",
          "housekeeping",
          "it",
        ],
      },
      properties: { type: "array", items: text, maxItems: 100 },
    },
    ["role", "properties"],
  ),
  "POST /api/tasks": object(
    {
      propertyId,
      title: { type: "string", minLength: 1, maxLength: 180 },
      priority: { enum: ["high", "normal", "low"] },
    },
    ["propertyId", "title", "priority"],
  ),
  "PATCH /api/tasks/:id": object(
    {
      propertyId,
      status: { enum: ["open", "acknowledged", "done"] },
      assignee: { anyOf: [text, { type: "null" }] },
    },
    ["propertyId", "status", "assignee"],
  ),
  "PATCH /api/rooms/:id": object(
    {
      propertyId,
      status: { enum: ["clean", "dirty", "inspected", "out_of_order"] },
      attention: { type: "string", maxLength: 180 },
    },
    ["propertyId", "status", "attention"],
  ),
  "PUT /api/connections": object(
    { propertyId, mode: { enum: ["demo"] }, environment: { enum: ["DEMO"] } },
    ["propertyId", "mode", "environment"],
  ),
  "POST /api/ohip-connections": object(
    {
      propertyId,
      baseUrl: { type: "string", maxLength: 300 },
      clientId: { type: "string", maxLength: 200 },
      clientSecret: { type: "string", maxLength: 1000, writeOnly: true },
      appKey: { type: "string", maxLength: 1000, writeOnly: true },
      enterpriseId: text,
      hotelId: text,
    },
    [
      "propertyId",
      "baseUrl",
      "clientId",
      "clientSecret",
      "appKey",
      "enterpriseId",
      "hotelId",
    ],
  ),
  "PATCH /api/ohip-connections/:id": object(
    {
      propertyId,
      baseUrl: { type: "string", maxLength: 300 },
      clientId: { type: "string", maxLength: 200 },
      clientSecret: { type: "string", maxLength: 1000, writeOnly: true },
      appKey: { type: "string", maxLength: 1000, writeOnly: true },
      enterpriseId: text,
      hotelId: text,
    },
    ["propertyId", "baseUrl", "clientId", "enterpriseId", "hotelId"],
  ),
  "POST /api/ohip-connections/:id/assign": object(
    { propertyId, hotelId: text },
    ["propertyId", "hotelId"],
  ),
  "POST /api/ohip-connections/:id/test": object({ propertyId }, ["propertyId"]),
  "POST /api/ohip-connections/:id/control": object(
    {
      propertyId,
      action: { enum: ["pause", "resume", "archive"] },
      confirmGlobal: { type: "boolean" },
    },
    ["action"],
  ),
  "PATCH /api/admin/:kind/:id": object(
    { name: text, organizationId: text, timezone: text },
    ["name"],
  ),
  "POST /api/retry-jobs/:id/retry": object({ propertyId }, ["propertyId"]),
  "PUT /api/branding": object(
    {
      appName: { type: "string", minLength: 1, maxLength: 60 },
      primary: { type: "string", pattern: "^#[a-fA-F0-9]{6}$" },
      logo: { type: "string", maxLength: 300 },
      favicon: { type: "string", maxLength: 300 },
    },
    ["appName", "primary", "logo", "favicon"],
  ),
  "POST /api/admin/organizations": object({ name: text }, ["name"]),
  "POST /api/admin/properties": object(
    { name: text, organizationId: text, timezone: text },
    ["name", "organizationId", "timezone"],
  ),
  "POST /api/admin/users": object(
    {
      name: text,
      email: { type: "string", format: "email" },
      password: {
        type: "string",
        minLength: 12,
        maxLength: 256,
        writeOnly: true,
      },
      role: {
        enum: [
          "platform_admin",
          "group_admin",
          "hotel_manager",
          "front_office",
          "housekeeping",
          "it",
        ],
      },
      properties: { type: "array", maxItems: 100, items: text },
    },
    ["name", "email", "password", "role", "properties"],
  ),
};
export function documentRoutes(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/")) return;
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    route.schema = {
      ...route.schema,
      tags: [
        route.url.includes("admin")
          ? "Administration"
          : route.url.includes("tasks")
            ? "Tasks"
            : route.url.includes("reservations")
              ? "Reservations"
              : "Operations",
      ],
      description:
        method === "GET"
          ? "Session authenticated; restricted to the current tenant and explicitly authorized properties."
          : "Session authenticated; x-csrf-token required; authorized actions are audited.",
    };
    if (bodies[`${method} ${route.url}`])
      route.schema.body = bodies[`${method} ${route.url}`];
    const params = [...route.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
    if (params.length)
      route.schema.params = object(
        Object.fromEntries(params.map((p) => [p, text])),
        params,
      );
    if (method === "GET") {
      if (
        [
          "/api/tasks",
          "/api/rooms",
          "/api/assignees",
          "/api/reservations/:id",
        ].includes(route.url)
      )
        route.schema.querystring = object({ propertyId, page, limit }, [
          "propertyId",
        ]);
      if (
        [
          "/api/connections",
          "/api/ohip-connections",
          "/api/integration-logs",
          "/api/retry-jobs",
          "/api/audit-logs",
        ].includes(route.url)
      )
        route.schema.querystring = query;
      if (route.url === "/api/overview")
        route.schema.querystring = object({
          propertyId,
          organizationId: text,
          date: day,
        });
      if (route.url === "/api/reservations")
        route.schema.querystring = object(
          {
            propertyId,
            page,
            limit,
            q: text,
            arrival: day,
            date: day,
            status: { type: "string", maxLength: 40 },
            view: {
              enum: ["arrivals", "departures", "vip", "inhouse", "changes"],
            },
          },
          ["propertyId"],
        );
    }
  });
}
