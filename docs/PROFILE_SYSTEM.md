# Account profiles

The public account page (`/profile`) provides overview, personal details,
security, and activity sections. The homepage profile sheet is a short menu;
console users continue to use `/console/account`. Student/Cinema identities and
console identities remain separate even when they have the same email address.

Account photos are optional and private. The browser crops the selected image
to a square, and the server validates and converts it to a 320-pixel WebP using
the Cloudflare Images binding before storing it in the private R2 bucket. The
photo endpoint always checks the signed-in account and sends `private, no-store`
responses. Cinema participants do not receive these photos. The original file
is never retained after conversion. Removing or replacing a photo deletes the
previous object when possible.

Apply `sql/045_account_profile_photos.sql` with the normal migration process.
The application also creates this small table on first use for environments
that have not yet run the migration. `PRIVATE_BUCKET` and `IMAGES` must be
available for uploads; without either binding, the API returns a configuration
error and existing account and security features remain usable.

The Activity section currently links to the relevant service pages and labels
ticket references as saved on this device. It is not an account-wide booking
history. Notification preferences and optional public Cinema avatars are not
part of this release.
