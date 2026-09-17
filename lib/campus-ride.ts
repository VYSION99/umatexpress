import { hasColumn, rowsToObjects, turso, isTursoConfiguredRuntime } from "@/lib/turso";

export type CampusZone = { id:string; name:string; description:string; landmark:string; latitude:number|null; longitude:number|null; active:boolean };
export type CampusCorridor = { id:string; name:string; originZoneId:string; destinationZoneId:string; estimatedMinutes:number; active:boolean; fare:number };
export type CampusVehicle = { id:string; label:string; plateNumber:string; vehicleType:string; capacity:number; active:boolean };
export type CampusDriver = { id:string; name:string; phone:string; email:string; vehicleId:string; currentZoneId:string; currentLatitude?:number|null; currentLongitude?:number|null; active:boolean; lastSeenAt:string; mustChangePassword?:boolean; passwordChangedAt?:string; tokenVersion?:number };
export type CampusRide = { id:string; driverId:string; vehicleId:string; corridorId:string; currentZoneId:string; currentLatitude?:number|null; currentLongitude?:number|null; status:string; capacity:number; availableSlots:number; acceptingQueue:boolean; lastLocationAt:string; driverName:string; vehicleLabel:string; plateNumber:string };
export type CampusQueueEntry = { id:string; reference:string; rideId:string; corridorId:string; passengerName:string; phone:string; email:string; pickupZoneId:string; destinationZoneId:string; pickupZone?:string; destinationZone?:string; queuePosition:number; amount:number; paymentStatus:string; queueStatus:string; ridePin?:string; acceptedAt?:string; arrivedAt?:string; boardedAt?:string; completedAt?:string; cancelledAt?:string; createdAt:string };

const now = () => new Date().toISOString();
const bool = (value: unknown) => Number(value) === 1 || value === true;

export const demoCampusZones: CampusZone[] = [
  { id:"main-gate", name:"UMaT Main Gate", description:"Primary pickup area near campus entrance.", landmark:"Main Gate", latitude:5.3009, longitude:-1.9897, active:true },
  { id:"main-campus", name:"Main Campus", description:"Central campus area.", landmark:"Administration block", latitude:5.3018, longitude:-1.9931, active:true },
  { id:"lecture-area", name:"Lecture Area", description:"Lecture halls and academic blocks.", landmark:"Lecture complex", latitude:5.3033, longitude:-1.9948, active:true },
  { id:"hostel-area", name:"Hostel Area", description:"Student hostel pickup zone.", landmark:"Hostel frontage", latitude:5.3064, longitude:-1.9972, active:true },
  { id:"tarkwa-station", name:"Tarkwa Station", description:"Station and transport yard area.", landmark:"Station", latitude:5.3011, longitude:-1.9842, active:true },
  { id:"market-circle", name:"Market Circle", description:"Market and town errands zone.", landmark:"Market", latitude:5.2992, longitude:-1.9818, active:true },
];

export const demoCampusCorridors: CampusCorridor[] = [
  { id:"gate-lecture", name:"Main Gate → Lecture Area", originZoneId:"main-gate", destinationZoneId:"lecture-area", estimatedMinutes:7, active:true, fare:500 },
  { id:"hostel-campus", name:"Hostel Area → Main Campus", originZoneId:"hostel-area", destinationZoneId:"main-campus", estimatedMinutes:8, active:true, fare:500 },
  { id:"campus-station", name:"Main Campus → Tarkwa Station", originZoneId:"main-campus", destinationZoneId:"tarkwa-station", estimatedMinutes:12, active:true, fare:800 },
  { id:"campus-market", name:"Main Campus → Market Circle", originZoneId:"main-campus", destinationZoneId:"market-circle", estimatedMinutes:14, active:true, fare:800 },
];

export const demoCampusVehicles: CampusVehicle[] = [
  { id:"veh-1", label:"Campus Shuttle 1", plateNumber:"UMX-101", vehicleType:"Shuttle", capacity:4, active:true },
  { id:"veh-2", label:"Campus Shuttle 2", plateNumber:"UMX-102", vehicleType:"Shuttle", capacity:6, active:true },
];

export const demoCampusDrivers: CampusDriver[] = [
  { id:"drv-1", name:"Campus Driver 1", phone:"0550000001", email:"driver1@umatexpress.local", vehicleId:"veh-1", currentZoneId:"main-gate", currentLatitude:5.3009, currentLongitude:-1.9897, active:true, lastSeenAt:now() },
  { id:"drv-2", name:"Campus Driver 2", phone:"0550000002", email:"driver2@umatexpress.local", vehicleId:"veh-2", currentZoneId:"hostel-area", currentLatitude:5.3064, currentLongitude:-1.9972, active:true, lastSeenAt:now() },
];

export const demoCampusRides: CampusRide[] = [
  { id:"ride-1", driverId:"drv-1", vehicleId:"veh-1", corridorId:"gate-lecture", currentZoneId:"main-gate", currentLatitude:5.3009, currentLongitude:-1.9897, status:"OPEN", capacity:4, availableSlots:3, acceptingQueue:true, lastLocationAt:now(), driverName:"Campus Driver 1", vehicleLabel:"Campus Shuttle 1", plateNumber:"UMX-101" },
  { id:"ride-2", driverId:"drv-2", vehicleId:"veh-2", corridorId:"hostel-campus", currentZoneId:"hostel-area", currentLatitude:5.3064, currentLongitude:-1.9972, status:"OPEN", capacity:6, availableSlots:5, acceptingQueue:true, lastLocationAt:now(), driverName:"Campus Driver 2", vehicleLabel:"Campus Shuttle 2", plateNumber:"UMX-102" },
];

export async function ensureCampusRideTables() {
  await turso(`CREATE TABLE IF NOT EXISTS campus_zones (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',landmark TEXT NOT NULL DEFAULT '',latitude REAL,longitude REAL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_route_corridors (id TEXT PRIMARY KEY,name TEXT NOT NULL,origin_zone_id TEXT NOT NULL,destination_zone_id TEXT NOT NULL,estimated_minutes INTEGER NOT NULL DEFAULT 10,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_fares (id TEXT PRIMARY KEY,corridor_id TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'GHS',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_vehicles (id TEXT PRIMARY KEY,label TEXT NOT NULL,plate_number TEXT NOT NULL DEFAULT '',vehicle_type TEXT NOT NULL DEFAULT 'Shuttle',capacity INTEGER NOT NULL DEFAULT 4,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_drivers (id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT UNIQUE,password_hash TEXT,password_salt TEXT,password_iterations INTEGER NOT NULL DEFAULT 100000,password_reset_required INTEGER NOT NULL DEFAULT 1,password_changed_at TEXT,vehicle_id TEXT,current_zone_id TEXT,current_latitude REAL,current_longitude REAL,active INTEGER NOT NULL DEFAULT 1,last_seen_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_driver_sessions (id TEXT PRIMARY KEY,driver_id TEXT NOT NULL,token_hash TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_rides (id TEXT PRIMARY KEY,driver_id TEXT,vehicle_id TEXT,corridor_id TEXT NOT NULL,current_zone_id TEXT,current_latitude REAL,current_longitude REAL,status TEXT NOT NULL DEFAULT 'OPEN',capacity INTEGER NOT NULL DEFAULT 4,available_slots INTEGER NOT NULL DEFAULT 4,accepting_queue INTEGER NOT NULL DEFAULT 1,started_at TEXT,ended_at TEXT,last_location_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_queue_entries (id TEXT PRIMARY KEY,reference TEXT UNIQUE NOT NULL,ride_id TEXT,corridor_id TEXT NOT NULL,passenger_name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',pickup_zone_id TEXT NOT NULL,destination_zone_id TEXT NOT NULL,queue_position INTEGER NOT NULL,amount INTEGER NOT NULL,payment_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',queue_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',ride_pin TEXT NOT NULL DEFAULT '',ticket_image_ready INTEGER NOT NULL DEFAULT 0,accepted_at TEXT,arrived_at TEXT,boarded_at TEXT,completed_at TEXT,cancelled_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_payments (id TEXT PRIMARY KEY,queue_entry_id TEXT NOT NULL,reference TEXT UNIQUE NOT NULL,provider TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'GHS',status TEXT NOT NULL DEFAULT 'PENDING',authorization_url TEXT,access_token_hash TEXT,paid_at TEXT,raw_response TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await turso(`CREATE TABLE IF NOT EXISTS campus_audit_logs (id TEXT PRIMARY KEY,actor_type TEXT NOT NULL,actor_id TEXT NOT NULL DEFAULT '',action TEXT NOT NULL,target_type TEXT NOT NULL,target_reference TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)`);
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_rides_status ON campus_rides(status)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_rides_driver ON campus_rides(driver_id)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_rides_current_zone ON campus_rides(current_zone_id)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_queue_ride_status ON campus_queue_entries(ride_id, queue_status)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_queue_reference ON campus_queue_entries(reference)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_payments_reference ON campus_payments(reference)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_payments_queue ON campus_payments(queue_entry_id)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_drivers_active_zone ON campus_drivers(active, current_zone_id)");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_audit_target ON campus_audit_logs(target_type, target_reference)");
  await turso("CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_queue_active_position ON campus_queue_entries(ride_id, queue_position) WHERE queue_status IN ('PAID_WAITING','ACCEPTED_BY_DRIVER','DRIVER_ARRIVED','BOARDED')");
  await turso("CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_drivers_phone ON campus_drivers(phone) WHERE phone <> ''");
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_drivers_password_reset ON campus_drivers(password_reset_required, active)");
  const queueColumns: Array<[string, string]> = [
    ["ride_pin", "ALTER TABLE campus_queue_entries ADD COLUMN ride_pin TEXT NOT NULL DEFAULT ''"],
    ["accepted_at", "ALTER TABLE campus_queue_entries ADD COLUMN accepted_at TEXT"],
    ["arrived_at", "ALTER TABLE campus_queue_entries ADD COLUMN arrived_at TEXT"],
    ["boarded_at", "ALTER TABLE campus_queue_entries ADD COLUMN boarded_at TEXT"],
    ["completed_at", "ALTER TABLE campus_queue_entries ADD COLUMN completed_at TEXT"],
    ["cancelled_at", "ALTER TABLE campus_queue_entries ADD COLUMN cancelled_at TEXT"],
    ["expires_at", "ALTER TABLE campus_queue_entries ADD COLUMN expires_at TEXT"],
  ];
  for (const [column, sql] of queueColumns) {
    if (!(await hasColumn("campus_queue_entries", column))) await turso(sql);
  }
  await turso("CREATE INDEX IF NOT EXISTS idx_campus_queue_expiry ON campus_queue_entries(queue_status, expires_at)");
  if (!(await hasColumn("campus_rides", "next_queue_position"))) {
    await turso("ALTER TABLE campus_rides ADD COLUMN next_queue_position INTEGER NOT NULL DEFAULT 1");
    // Backfill so existing rides never hand out a position that is already taken.
    await turso("UPDATE campus_rides SET next_queue_position = COALESCE((SELECT MAX(queue_position) + 1 FROM campus_queue_entries q WHERE q.ride_id = campus_rides.id), 1)");
  }
  const paymentColumns: Array<[string, string]> = [
    ["fare_amount", "ALTER TABLE campus_payments ADD COLUMN fare_amount INTEGER NOT NULL DEFAULT 0"],
    ["fee_amount", "ALTER TABLE campus_payments ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [column, sql] of paymentColumns) {
    if (!(await hasColumn("campus_payments", column))) await turso(sql);
  }
  const driverColumns: Array<[string, string]> = [
    ["password_reset_required", "ALTER TABLE campus_drivers ADD COLUMN password_reset_required INTEGER NOT NULL DEFAULT 1"],
    ["password_changed_at", "ALTER TABLE campus_drivers ADD COLUMN password_changed_at TEXT"],
    ["token_version", "ALTER TABLE campus_drivers ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [column, sql] of driverColumns) {
    if (!(await hasColumn("campus_drivers", column))) await turso(sql);
  }
}

function slug(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || crypto.randomUUID();
}

export async function upsertCampusZone(input: { id?: string; name?: string; description?: string; landmark?: string; latitude?: string | number; longitude?: string | number; active?: boolean }) {
  if (!(await isTursoConfiguredRuntime())) throw new Error("Configure Turso before saving campusRide zones.");
  await ensureCampusRideTables();
  const stamp = now();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Zone name is required.");
  const id = String(input.id || slug(name)).trim();
  await turso(
    "INSERT INTO campus_zones (id,name,description,landmark,latitude,longitude,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,landmark=excluded.landmark,latitude=excluded.latitude,longitude=excluded.longitude,active=excluded.active,updated_at=excluded.updated_at",
    [id, name, String(input.description || ""), String(input.landmark || ""), String(input.latitude || ""), String(input.longitude || ""), input.active === false ? 0 : 1, stamp, stamp],
  );
  return (await getCampusData()).zones.find((zone) => zone.id === id);
}

export async function upsertCampusCorridor(input: { id?: string; name?: string; originZoneId?: string; destinationZoneId?: string; estimatedMinutes?: string | number; fare?: string | number; active?: boolean }) {
  if (!(await isTursoConfiguredRuntime())) throw new Error("Configure Turso before saving campusRide corridors.");
  await ensureCampusRideTables();
  const stamp = now();
  const name = String(input.name || "").trim();
  const origin = String(input.originZoneId || "").trim();
  const destination = String(input.destinationZoneId || "").trim();
  const estimatedMinutes = Math.max(1, Math.round(Number(input.estimatedMinutes || 10)));
  const fare = Math.max(0, Math.round(Number(input.fare || 0) * 100));
  if (!name || !origin || !destination) throw new Error("Corridor name, origin, and destination are required.");
  if (origin === destination) throw new Error("Origin and destination cannot be the same.");
  const id = String(input.id || slug(name)).trim();
  await turso(
    "INSERT INTO campus_route_corridors (id,name,origin_zone_id,destination_zone_id,estimated_minutes,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,origin_zone_id=excluded.origin_zone_id,destination_zone_id=excluded.destination_zone_id,estimated_minutes=excluded.estimated_minutes,active=excluded.active,updated_at=excluded.updated_at",
    [id, name, origin, destination, estimatedMinutes, input.active === false ? 0 : 1, stamp, stamp],
  );
  await turso(
    "INSERT INTO campus_fares (id,corridor_id,amount,currency,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,active=excluded.active,updated_at=excluded.updated_at",
    [`fare-${id}`, id, fare, "GHS", input.active === false ? 0 : 1, stamp, stamp],
  );
  return (await getCampusData()).corridors.find((corridor) => corridor.id === id);
}

export async function upsertCampusVehicle(input: { id?: string; label?: string; plateNumber?: string; vehicleType?: string; capacity?: string | number; active?: boolean }) {
  if (!(await isTursoConfiguredRuntime())) throw new Error("Configure Turso before saving campusRide vehicles.");
  await ensureCampusRideTables();
  const stamp = now();
  const label = String(input.label || "").trim();
  const capacity = Math.max(1, Math.round(Number(input.capacity || 4)));
  if (!label) throw new Error("Vehicle label is required.");
  const id = String(input.id || slug(label)).trim();
  await turso(
    "INSERT INTO campus_vehicles (id,label,plate_number,vehicle_type,capacity,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,plate_number=excluded.plate_number,vehicle_type=excluded.vehicle_type,capacity=excluded.capacity,active=excluded.active,updated_at=excluded.updated_at",
    [id, label, String(input.plateNumber || ""), String(input.vehicleType || "Shuttle"), capacity, input.active === false ? 0 : 1, stamp, stamp],
  );
  return (await getCampusData()).vehicles.find((vehicle) => vehicle.id === id);
}

export async function upsertCampusDriver(input: { id?: string; name?: string; phone?: string; email?: string; vehicleId?: string; currentZoneId?: string; active?: boolean }) {
  if (!(await isTursoConfiguredRuntime())) throw new Error("Configure Turso before saving campusRide drivers.");
  await ensureCampusRideTables();
  const stamp = now();
  const name = String(input.name || "").trim();
  const phone = String(input.phone || "").trim();
  if (!name || !phone) throw new Error("Driver name and phone are required.");
  const id = String(input.id || slug(`${name}-${phone}`)).trim();
  await turso(
    "INSERT INTO campus_drivers (id,name,phone,email,vehicle_id,current_zone_id,active,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,email=excluded.email,vehicle_id=excluded.vehicle_id,current_zone_id=excluded.current_zone_id,active=excluded.active,updated_at=excluded.updated_at",
    [id, name, phone, String(input.email || ""), String(input.vehicleId || ""), String(input.currentZoneId || ""), input.active === false ? 0 : 1, stamp, stamp, stamp],
  );
  const { ensureDriverPassword } = await import("@/lib/campus-engine/driver-auth");
  await ensureDriverPassword(id);
  return (await getCampusData()).drivers.find((driver) => driver.id === id);
}

export async function getCampusData() {
  if (!(await isTursoConfiguredRuntime())) {
    return { zones: demoCampusZones, corridors: demoCampusCorridors, vehicles: demoCampusVehicles, drivers: demoCampusDrivers, rides: demoCampusRides };
  }
  // Keep the public read path fast and side-effect free. Schema creation and
  // seed writes belong to migrations/admin mutations; doing them here caused
  // every CampusRide page view to issue dozens of Turso requests and could
  // exhaust the Worker's request budget before React rendered the page.
  const [zoneResult, corridorResult, vehicleResult, driverResult, rideResult] = await Promise.all([
    turso("SELECT id,name,description,landmark,latitude,longitude,active FROM campus_zones WHERE active = 1 ORDER BY name"),
    turso("SELECT c.id,c.name,c.origin_zone_id,c.destination_zone_id,c.estimated_minutes,c.active,COALESCE(f.amount,0) AS fare FROM campus_route_corridors c LEFT JOIN campus_fares f ON f.corridor_id = c.id AND f.active = 1 WHERE c.active = 1 ORDER BY c.name"),
    turso("SELECT id,label,plate_number,vehicle_type,capacity,active FROM campus_vehicles ORDER BY label"),
    turso("SELECT id,name,phone,COALESCE(email,'') AS email,COALESCE(vehicle_id,'') AS vehicle_id,COALESCE(current_zone_id,'') AS current_zone_id,current_latitude,current_longitude,active,COALESCE(last_seen_at,'') AS last_seen_at,COALESCE(password_reset_required,1) AS password_reset_required,COALESCE(password_changed_at,'') AS password_changed_at,COALESCE(token_version,0) AS token_version FROM campus_drivers ORDER BY name"),
    turso(`SELECT r.id,r.driver_id,r.vehicle_id,r.corridor_id,r.current_zone_id,r.current_latitude,r.current_longitude,r.status,r.capacity,r.available_slots,r.accepting_queue,COALESCE(r.last_location_at,'') AS last_location_at,COALESCE(d.name,'Unassigned driver') AS driver_name,COALESCE(v.label,'Unassigned vehicle') AS vehicle_label,COALESCE(v.plate_number,'') AS plate_number FROM campus_rides r LEFT JOIN campus_drivers d ON d.id = r.driver_id LEFT JOIN campus_vehicles v ON v.id = r.vehicle_id WHERE r.status IN ('OPEN','PAUSED','FULL') ORDER BY r.updated_at DESC`),
  ]);
  return {
    zones: rowsToObjects(zoneResult).map((row) => ({ id:String(row.id), name:String(row.name), description:String(row.description||""), landmark:String(row.landmark||""), latitude:Number(row.latitude)||null, longitude:Number(row.longitude)||null, active:bool(row.active) })),
    corridors: rowsToObjects(corridorResult).map((row) => ({ id:String(row.id), name:String(row.name), originZoneId:String(row.origin_zone_id), destinationZoneId:String(row.destination_zone_id), estimatedMinutes:Number(row.estimated_minutes)||0, active:bool(row.active), fare:Number(row.fare)||0 })),
    vehicles: rowsToObjects(vehicleResult).map((row) => ({ id:String(row.id), label:String(row.label), plateNumber:String(row.plate_number||""), vehicleType:String(row.vehicle_type||"Shuttle"), capacity:Number(row.capacity)||0, active:bool(row.active) })),
    drivers: rowsToObjects(driverResult).map((row) => ({ id:String(row.id), name:String(row.name), phone:String(row.phone), email:String(row.email||""), vehicleId:String(row.vehicle_id||""), currentZoneId:String(row.current_zone_id||""), currentLatitude:Number(row.current_latitude)||null, currentLongitude:Number(row.current_longitude)||null, active:bool(row.active), lastSeenAt:String(row.last_seen_at||""), mustChangePassword:bool(row.password_reset_required), passwordChangedAt:String(row.password_changed_at||""), tokenVersion:Number(row.token_version||0) })),
    rides: rowsToObjects(rideResult).map((row) => ({ id:String(row.id), driverId:String(row.driver_id||""), vehicleId:String(row.vehicle_id||""), corridorId:String(row.corridor_id), currentZoneId:String(row.current_zone_id||""), currentLatitude:Number(row.current_latitude)||null, currentLongitude:Number(row.current_longitude)||null, status:String(row.status), capacity:Number(row.capacity)||0, availableSlots:Number(row.available_slots)||0, acceptingQueue:bool(row.accepting_queue), lastLocationAt:String(row.last_location_at||""), driverName:String(row.driver_name||"Unassigned driver"), vehicleLabel:String(row.vehicle_label||"Unassigned vehicle"), plateNumber:String(row.plate_number||"") })),
  };
}
