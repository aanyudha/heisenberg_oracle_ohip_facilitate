ALTER TABLE housekeeping_room_directory ADD COLUMN location_source text NOT NULL DEFAULT 'local_validated';
ALTER TABLE housekeeping_room_directory ADD COLUMN credits_configured boolean NOT NULL DEFAULT true;
ALTER TABLE housekeeping_attendant_assignments ADD COLUMN worksheet_active boolean NOT NULL DEFAULT true;
ALTER TABLE change_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE TABLE housekeeping_room_feeds (
 tenant_id text NOT NULL, property_id text NOT NULL, business_date date NOT NULL,
 binding text NOT NULL, status text NOT NULL, error text, task_error text,
 rooms jsonb NOT NULL DEFAULT '[]', synced_at timestamptz, attempted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,property_id,business_date),
 FOREIGN KEY(tenant_id,property_id) REFERENCES properties(tenant_id,id)
);
CREATE TABLE housekeeping_worksheet_changes (
 id text PRIMARY KEY,
 tenant_id text NOT NULL, property_id text NOT NULL, business_date date NOT NULL, shift_id text NOT NULL,
 actor text NOT NULL REFERENCES users(id), mutation_id text NOT NULL, request_hash text NOT NULL,
 base_revision text NOT NULL, result_revision text NOT NULL,
 before_plan jsonb NOT NULL, after_plan jsonb NOT NULL, undo_plan jsonb NOT NULL, undo_of text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,property_id,mutation_id),
 FOREIGN KEY(tenant_id,property_id,shift_id) REFERENCES housekeeping_shifts(tenant_id,property_id,id),
 FOREIGN KEY(undo_of) REFERENCES housekeeping_worksheet_changes(id)
);
CREATE INDEX housekeeping_worksheet_scope ON housekeeping_worksheet_changes(tenant_id,property_id,business_date,shift_id,created_at);
