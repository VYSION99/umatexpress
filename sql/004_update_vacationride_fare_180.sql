-- Update the current vacationRide fare from GHS 190 to GHS 180.
-- Safe to run on Turso after deploying the code change.

UPDATE scheduled_trips
SET price = 180,
    updated_at = datetime('now')
WHERE price = 190;

UPDATE trip_settings
SET flyer_promo = replace(flyer_promo, 'GHS 190', 'GHS 180'),
    updated_at = datetime('now')
WHERE flyer_promo LIKE '%GHS 190%';
