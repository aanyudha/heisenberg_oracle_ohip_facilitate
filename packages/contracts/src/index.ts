export const roles = [
  "platform_admin",
  "group_admin",
  "hotel_manager",
  "front_office",
  "housekeeping",
  "it",
] as const;
export type Role = (typeof roles)[number];
export type WorksheetScope = {
  propertyId: string;
  date: string;
  shiftId: string;
};
export type WorksheetRoom = {
  occupancy?: "Occupied" | "Vacant" | null;
  id: string;
  floor: string | null;
  floorSource: "OHIP" | "local_validated" | "unavailable";
  section: string | null;
  roomType: string | null;
  status: string;
  departure: boolean;
  stayover: boolean;
  arrival: boolean;
  vip: boolean;
  dnd: boolean;
  makeUpRoom: boolean;
  outOfOrder: boolean;
  outOfService: boolean;
  priority: boolean;
  tasks: string[];
  remarks: string[];
  credits: number | null;
  creditSource: "OHIP" | "local" | "not_configured";
  observedAt: string | null;
};
export type WorksheetStaff = {
  id: string;
  name: string;
  available: boolean;
  active: boolean;
  eligibilityReason?:
    | "inactive"
    | "wrong_role"
    | "wrong_property"
    | "not_scheduled"
    | "off_shift"
    | "not_registered"
    | null;
  assignmentBlockReason?:
    "supervisor_required" | "supervisor_unavailable" | null;
};
export { distributeRooms } from "./distribution.js";
export type WorksheetOperation =
  | { type: "schedule"; userIds: string[] }
  | {
      type: "distribute";
      roomIds: string[];
      attendantIds: string[];
      mode: "equal" | "credits";
    }
  | { type: "rooms"; roomIds: string[]; attendantId: string | null }
  | { type: "team"; attendantId: string; supervisorId: string }
  | {
      type: "floors";
      floorIds: string[];
      supervisorId: string | null;
      replace?: boolean;
    }
  | { type: "coverage"; roomIds: string[]; supervisorId: string | null };
export type WorksheetFloor = {
  id: string;
  supervisorId: string | null;
  totalRooms: number;
  assignedRooms: number;
  unassignedRooms: number;
  credits: number;
  missingCredits: number;
  exceptionRooms: number;
  conflict: boolean;
};
export type SupervisorCoverage = {
  supervisorId: string;
  floors: string[];
  rooms: string[];
  coverage: string[];
};
export {
  resolveWorksheetCoverage,
  worksheetFloorRows,
} from "./housekeeping.js";
export type Worksheet = {
  rosterConfigured?: boolean;
  scope: WorksheetScope;
  property: { id: string; name: string };
  shift: { id: string; name: string };
  revision: string;
  savedAt?: string | null;
  selfRole: string | null;
  manager: boolean;
  canManage: boolean;
  rooms: WorksheetRoom[];
  supervisors: WorksheetStaff[];
  attendants: WorksheetStaff[];
  team: Record<string, string>;
  assignments: Record<string, string>;
  localProgress: Record<string, string>;
  feed: {
    source: "OHIP" | "DEMO";
    available: boolean;
    status: string;
    error: string | null;
    taskError: string | null;
    syncedAt: string | null;
    stale?: boolean;
  };
  missingAssignedRooms: number;
  warnings: string[];
  floorAssignments?: WorksheetFloor[];
  supervisorFloors?: Record<string, string[]>;
  roomSupervisors?: Record<string, string | null>;
  roomExceptions?: Record<string, string>;
};
export type Property = {
  id: string;
  name: string;
  organization_id: string;
  timezone: string;
};
export type Identity = {
  housekeepingRoles?: {
    propertyId: string;
    jobRole: string;
    canManage: boolean;
  }[];
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
  details?: { kind?: string; date?: string; shiftId?: string };
  seq: number;
  propertyId: string | null;
  topic:
    | "tasks"
    | "reservations"
    | "rooms"
    | "housekeeping"
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
  freshness?: "demo" | "not_synced" | "stale" | "synced";
  source: string;
};
export const canIntegrate = (role: Role) =>
  ["platform_admin", "group_admin", "hotel_manager", "it"].includes(role);
export const canAdmin = (role: Role) =>
  ["platform_admin", "group_admin"].includes(role);
export const canGuests = (role: Role) =>
  role !== "housekeeping" && role !== "it";
