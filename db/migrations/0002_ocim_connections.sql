CREATE TABLE ohip_connections (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  base_url text NOT NULL,
  client_id text NOT NULL,
  encrypted_client_secret text NOT NULL,
  encrypted_app_key text NOT NULL,
  enterprise_id text NOT NULL,
  status text NOT NULL DEFAULT 'not_connected',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id)
);
CREATE TABLE ohip_connection_properties (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  property_id text NOT NULL,
  hotel_id text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  validation_status text NOT NULL DEFAULT 'pending' CHECK(validation_status IN ('pending','validated','invalid')),
  last_validated_at timestamptz,
  UNIQUE(tenant_id,property_id),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES ohip_connections(tenant_id,id),
  FOREIGN KEY(tenant_id,property_id) REFERENCES properties(tenant_id,id)
);
CREATE UNIQUE INDEX ohip_primary_property ON ohip_connection_properties(tenant_id,connection_id) WHERE is_primary;
CREATE INDEX ohip_assignment_connection ON ohip_connection_properties(tenant_id,connection_id);
