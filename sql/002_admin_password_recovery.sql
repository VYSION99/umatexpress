-- Emergency admin password recovery.
--
-- Use this only if the admin password is forgotten.
-- It removes the stored hashed password for one admin email so the app falls
-- back to the bootstrap ADMIN_PASSWORD secret/env value on next login.
--
-- Steps:
-- 1. Replace admin@example.com with the affected admin email.
-- 2. Run the statement in Turso.
-- 3. Sign in with the ADMIN_PASSWORD value from your environment/Cloudflare secret.
-- 4. Immediately change the password again from /admin/change-password.

DELETE FROM admin_credentials
WHERE email = 'admin@example.com';
