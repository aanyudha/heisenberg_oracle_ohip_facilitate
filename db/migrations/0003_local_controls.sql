ALTER TABLE ohip_connections ADD COLUMN paused boolean NOT NULL DEFAULT false;
ALTER TABLE ohip_connections ADD COLUMN archived_at timestamptz;
ALTER TABLE ohip_connection_properties ADD COLUMN paused boolean NOT NULL DEFAULT false;
ALTER TABLE ohip_connection_properties ADD COLUMN control_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE local_archives (
 tenant_id text NOT NULL REFERENCES tenants(id),
 kind text NOT NULL CHECK(kind IN ('tenants','organizations','properties','users')),
 target text NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,kind,target)
);
