-- CampusRide pickup and destination IDs both reference campus_zones. Existing
-- rows keep their coordinates; future writes must provide a valid point.
CREATE TRIGGER IF NOT EXISTS campus_zone_coordinates_insert
BEFORE INSERT ON campus_zones
WHEN NEW.latitude IS NULL OR NEW.longitude IS NULL
  OR typeof(NEW.latitude) NOT IN ('integer', 'real')
  OR typeof(NEW.longitude) NOT IN ('integer', 'real')
  OR NEW.latitude NOT BETWEEN -90 AND 90
  OR NEW.longitude NOT BETWEEN -180 AND 180
BEGIN
  SELECT RAISE(ABORT, 'Campus zones require valid latitude and longitude');
END;

CREATE TRIGGER IF NOT EXISTS campus_zone_coordinates_update
BEFORE UPDATE ON campus_zones
WHEN NEW.latitude IS NULL OR NEW.longitude IS NULL
  OR typeof(NEW.latitude) NOT IN ('integer', 'real')
  OR typeof(NEW.longitude) NOT IN ('integer', 'real')
  OR NEW.latitude NOT BETWEEN -90 AND 90
  OR NEW.longitude NOT BETWEEN -180 AND 180
BEGIN
  SELECT RAISE(ABORT, 'Campus zones require valid latitude and longitude');
END;

CREATE TRIGGER IF NOT EXISTS campus_corridor_zones_insert
BEFORE INSERT ON campus_route_corridors
WHEN NEW.origin_zone_id = NEW.destination_zone_id
  OR NOT EXISTS (SELECT 1 FROM campus_zones WHERE id = NEW.origin_zone_id AND active = 1)
  OR NOT EXISTS (SELECT 1 FROM campus_zones WHERE id = NEW.destination_zone_id AND active = 1)
BEGIN
  SELECT RAISE(ABORT, 'Campus corridor requires two distinct active zones');
END;

CREATE TRIGGER IF NOT EXISTS campus_corridor_zones_update
BEFORE UPDATE OF origin_zone_id, destination_zone_id ON campus_route_corridors
WHEN NEW.origin_zone_id = NEW.destination_zone_id
  OR NOT EXISTS (SELECT 1 FROM campus_zones WHERE id = NEW.origin_zone_id AND active = 1)
  OR NOT EXISTS (SELECT 1 FROM campus_zones WHERE id = NEW.destination_zone_id AND active = 1)
BEGIN
  SELECT RAISE(ABORT, 'Campus corridor requires two distinct active zones');
END;
