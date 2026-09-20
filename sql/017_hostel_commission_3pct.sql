-- 017: the hostel platform rate moves from 9% to 3%.
--
-- The rate lives on the landlord row and is copied onto each booking when the
-- money arrives, so this migration never rewrites a booking that has already
-- been paid: those rows keep the rate they were charged.
--
-- A landlord still on 900 was on the platform default — nobody negotiates a
-- rate equal to the default — so those rows move to 3%. Any other value is a
-- rate somebody set on purpose and is left alone.

UPDATE hostel_landlords SET commission_bps = 300, updated_at = updated_at WHERE commission_bps = 900;
