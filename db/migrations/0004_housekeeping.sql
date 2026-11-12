CREATE TABLE housekeeping_staff_profiles (
 tenant_id text NOT NULL, property_id text NOT NULL, user_id text NOT NULL,
 department text NOT NULL CHECK(department='Housekeeping'),
 job_role text NOT NULL CHECK(job_role IN ('manager','supervisor','attendant')),
 can_manage boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,property_id,user_id),
 FOREIGN KEY(tenant_id,user_id,property_id) REFERENCES property_grants(tenant_id,user_id,property_id) ON DELETE CASCADE
);
CREATE TABLE housekeeping_room_directory (
 tenant_id text NOT NULL, property_id text NOT NULL, room_id text NOT NULL,
 floor text NOT NULL, section text NOT NULL DEFAULT '',
 departure_credits numeric(8,2) NOT NULL CHECK(departure_credits>=0),
 stayover_credits numeric(8,2) NOT NULL CHECK(stayover_credits>=0),
 other_credits numeric(8,2) NOT NULL DEFAULT 0 CHECK(other_credits>=0),
 validated_by text NOT NULL REFERENCES users(id), validated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,property_id,room_id),
 FOREIGN KEY(tenant_id,property_id) REFERENCES properties(tenant_id,id)
);
CREATE TABLE housekeeping_shifts (
 tenant_id text NOT NULL, property_id text NOT NULL, id text NOT NULL,
 name text NOT NULL, starts_at time NOT NULL, ends_at time NOT NULL,
 PRIMARY KEY(tenant_id,property_id,id),
 FOREIGN KEY(tenant_id,property_id) REFERENCES properties(tenant_id,id)
);
CREATE TABLE housekeeping_staff_schedules (
 tenant_id text NOT NULL, property_id text NOT NULL, business_date date NOT NULL, shift_id text NOT NULL, user_id text NOT NULL,
 available boolean NOT NULL,
 PRIMARY KEY(tenant_id,property_id,business_date,shift_id,user_id),
 FOREIGN KEY(tenant_id,property_id,shift_id) REFERENCES housekeeping_shifts(tenant_id,property_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE housekeeping_supervisor_assignments (
 tenant_id text NOT NULL, property_id text NOT NULL, business_date date NOT NULL, shift_id text NOT NULL, supervisor_id text NOT NULL,
 floors jsonb NOT NULL, rooms jsonb NOT NULL, coverage jsonb NOT NULL,
 PRIMARY KEY(tenant_id,property_id,business_date,shift_id,supervisor_id),
 FOREIGN KEY(tenant_id,property_id,business_date,shift_id,supervisor_id) REFERENCES housekeeping_staff_schedules(tenant_id,property_id,business_date,shift_id,user_id)
);
CREATE TABLE housekeeping_attendant_assignments (
 tenant_id text NOT NULL, property_id text NOT NULL, business_date date NOT NULL, shift_id text NOT NULL, attendant_id text NOT NULL, supervisor_id text NOT NULL,
 floors jsonb NOT NULL, sections jsonb NOT NULL, rooms jsonb NOT NULL,
 PRIMARY KEY(tenant_id,property_id,business_date,shift_id,attendant_id),
 FOREIGN KEY(tenant_id,property_id,business_date,shift_id,attendant_id) REFERENCES housekeeping_staff_schedules(tenant_id,property_id,business_date,shift_id,user_id),
 FOREIGN KEY(tenant_id,property_id,business_date,shift_id,supervisor_id) REFERENCES housekeeping_supervisor_assignments(tenant_id,property_id,business_date,shift_id,supervisor_id)
);
CREATE TABLE housekeeping_room_assignments (
 id text PRIMARY KEY,
 tenant_id text NOT NULL, property_id text NOT NULL, business_date date NOT NULL, shift_id text NOT NULL, attendant_id text NOT NULL, room_id text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 local_status text NOT NULL DEFAULT 'assigned' CHECK(local_status IN ('assigned','in_progress','completed','released')),
 baseline_status text NOT NULL, baseline_attention text NOT NULL, baseline_at timestamptz,
 assigned_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,property_id,business_date,shift_id,attendant_id) REFERENCES housekeeping_attendant_assignments(tenant_id,property_id,business_date,shift_id,attendant_id),
 FOREIGN KEY(tenant_id,property_id,room_id) REFERENCES housekeeping_room_directory(tenant_id,property_id,room_id)
);
CREATE UNIQUE INDEX housekeeping_one_active_room ON housekeeping_room_assignments(tenant_id,property_id,business_date,shift_id,room_id) WHERE active;
CREATE INDEX housekeeping_assignment_scope ON housekeeping_room_assignments(tenant_id,property_id,business_date,shift_id);
