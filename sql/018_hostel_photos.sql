-- 018: property photos become usable.
--
-- The table has existed since 014 with an r2_key and a status; this pass adds
-- the owner, the optional room, the file facts a gallery needs to render, and
-- the moderation trail. Bytes live in the private R2 bucket, so a row is also
-- the access decision: only an APPROVED row is served to the public route.

ALTER TABLE hostel_property_photos ADD COLUMN landlord_id TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN room_id TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN content_type TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hostel_property_photos ADD COLUMN review_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_hostel_photos_landlord ON hostel_property_photos(landlord_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_photos_status ON hostel_property_photos(status, created_at DESC);

-- Rows uploaded before this pass carried no owner; the property owns them.
UPDATE hostel_property_photos SET landlord_id = COALESCE((SELECT p.landlord_id FROM hostel_properties p WHERE p.id = hostel_property_photos.property_id), '')
  WHERE landlord_id = '';
