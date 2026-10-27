export const roles = [
  "platform_admin",
  "group_admin",
  "hotel_manager",
  "front_office",
  "housekeeping",
  "it",
] as const;
export type Role = (typeof roles)[number];
export type Property = {
  id: string;
  name: string;
  organization_id: string;
  timezone: string;
};
export type Identity = {
  id: string;
  name: string;
  tenantId: string;
  role: Role;
  properties: Property[];
  csrf: string;
  branding: Branding;
  tenants?: { id: string; name: string }[];
};
export type Branding = {
  appName: string;
  primary: string;
  logo: string;
  favicon: string;
};
export type Reservation = {
  id: string;
  confirmation: string;
  guest_name: string;
  arrival: string;
  departure: string;
  status: string;
  room: string | null;
  vip: boolean;
  updated_at: string;
  source: string;
};
export type Task = {
  id: string;
  title: string;
  priority: string;
  status: string;
  assignee: string | null;
  updated_at: string;
};
export type ChangeEvent = {
  seq: number;
  propertyId: string | null;
  topic:
    | "tasks"
    | "reservations"
    | "rooms"
    | "integrations"
    | "branding"
    | "reconcile";
  at: string;
};
export type Summary = {
  property: Property;
  arrivals: number;
  departures: number;
  inHouse: number;
  vip: number;
  pending: number;
  attention: number;
  changes: number;
  connection: string;
  lastSync: string | null;
  source: string;
};
export const canIntegrate = (role: Role) =>
  ["platform_admin", "group_admin", "hotel_manager", "it"].includes(role);
export const canAdmin = (role: Role) =>
  ["platform_admin", "group_admin"].includes(role);
export const canGuests = (role: Role) =>
  role !== "housekeeping" && role !== "it";
