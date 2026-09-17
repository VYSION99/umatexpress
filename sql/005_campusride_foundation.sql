CREATE TABLE IF NOT EXISTS campus_zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  landmark TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_route_corridors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin_zone_id TEXT NOT NULL,
  destination_zone_id TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_fares (
  id TEXT PRIMARY KEY,
  corridor_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_vehicles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  plate_number TEXT NOT NULL DEFAULT '',
  vehicle_type TEXT NOT NULL DEFAULT 'Shuttle',
  capacity INTEGER NOT NULL DEFAULT 4,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  vehicle_id TEXT,
  current_zone_id TEXT,
  current_latitude REAL,
  current_longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_driver_sessions (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_rides (
  id TEXT PRIMARY KEY,
  driver_id TEXT,
  vehicle_id TEXT,
  corridor_id TEXT NOT NULL,
  current_zone_id TEXT,
  current_latitude REAL,
  current_longitude REAL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  capacity INTEGER NOT NULL DEFAULT 4,
  available_slots INTEGER NOT NULL DEFAULT 4,
  accepting_queue INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  ended_at TEXT,
  last_location_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_queue_entries (
  id TEXT PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  ride_id TEXT,
  corridor_id TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  pickup_zone_id TEXT NOT NULL,
  destination_zone_id TEXT NOT NULL,
  queue_position INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  queue_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  ride_pin TEXT NOT NULL DEFAULT '',
  ticket_image_ready INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  arrived_at TEXT,
  boarded_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_payments (
  id TEXT PRIMARY KEY,
  queue_entry_id TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'PENDING',
  authorization_url TEXT,
  access_token_hash TEXT,
  paid_at TEXT,
  raw_response TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_ticket_events (
  id TEXT PRIMARY KEY,
  queue_entry_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_announcements (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL DEFAULT 'ALL',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_reference TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
