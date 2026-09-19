# Zero Trust for UMaTeXPRESS

**Status:** plan — waiting on a Cloudflare account owned by UMaTeXPRESS
**Goal:** UMaTeXPRESS gets its own Zero Trust team, separate from `acmdresearch`.

---

## 1. Why a new Cloudflare account is required

Cloudflare allows exactly **one Zero Trust organization per account**. Today the
Worker and the `acmdresearch` team live in the same account:

| Thing | Value |
|-------|-------|
| Account | `2cb953c44545e934bf2f206b73d89041` — "Acmdevelopers2020@gmail.com's Account" |
| Zero Trust team | `acmdresearch` → `acmdresearch.cloudflareaccess.com` |
| Worker | `umatexpress` → `umatexpress.acmdevelopers2020.workers.dev` |

Renaming the team would take `acmdresearch.cloudflareaccess.com` away from the
other system, and a second team cannot be created beside it. So UMaTeXPRESS gets
its own account, its own team (`umatexpress.cloudflareaccess.com`), and its own
copy of the deployment.

What moves: the Worker, its R2 bucket, notification queue, rate-limiter Durable
Object, and the Worker secrets. What does not move: the Turso database, Resend,
Paystack, and the domain — they are external services and keep working.

## 2. Phase 0 — decide once

1. The account email. It owns billing and recovery; pick something the team can
   hold long-term.
2. The account `workers.dev` subdomain (Account Home → Workers & Pages). It
   becomes part of every URL, e.g. `umx` → `umatexpress.umx.workers.dev`, and
   changing it later breaks old links.
3. The team name. `umatexpress` if free; the domain is globally unique.

## 3. Phase 1 — create the account and an API token

1. Sign up at `dash.cloudflare.com` with the UMaTeXPRESS email and verify it.
2. Set the `workers.dev` subdomain.
3. Create a token at **My Profile → API Tokens → Create Token** with:
   - Account · Workers Scripts · Edit
   - Account · Workers R2 Storage · Edit
   - Account · Queues · Edit
   - Account · Access: Apps and Policies · Edit
   - Account · Access: Organizations · Edit (if offered)
   - Account · Account Settings · Read
4. Put the new values in `.env`:

   ```bash
   CLOUDFLARE_ACCOUNT_ID=<new account id>
   CLOUDFLARE_KEY=<new api token>
   ```

## 4. Phase 2 — create the team

Dashboard → **Zero Trust** → choose the team name (`umatexpress`). The Free plan
is enough for 50 users. Write the new team domain down; it is what staff and
organizers will see on the sign-in page.

## 5. Phase 3 — deploy and re-seed secrets

```bash
# Creates the R2 bucket, queue (and DLQ), Durable Object namespace, then deploys.
npm run deploy:cloudflare

# Pushes every runtime secret from .env to the Worker in the selected account.
scripts/push-secrets.sh
```

Before pushing, set `CAMPUS_APP_URL` in `.env` to the new host — it is what
ticket links in emails point at. `CLOUDFLARE_AI_TOKEN` is not in `.env`; either
add it or drop the token fallback (the AI binding is preferred anyway).

If Cloudflare Images is not enabled on the new account (it is a paid product),
deploy with `CLOUDFLARE_IMAGES_BINDING=` — a key that is present but empty is a
deliberately disabled binding. Enable it and unset the empty value when needed.

The first deploy prints the new `workers.dev` URL. Leave the old Worker running
until the switch is verified.

## 6. Phase 4 — the Access application and policy

This is the policy that actually decides who reaches UMaTeXPRESS.

1. Zero Trust → **Access → Applications → Add an application → Self-hosted**.
2. Application domain: `umatexpress.<new-subdomain>.workers.dev` (add
   `console.umatexpress.com` later, once the domain is wired).
3. Session duration `8h`, and pick the identity provider (One-time PIN works
   with no IdP setup).
4. Policy: **Allow** for the staff and organizer emails, or an email-domain rule
   if the organization has one. Anyone not matched is refused before the Worker
   runs — it is the outermost gate, in front of the console login.

The same thing through the documented API, with the new account's token:

```bash
ACCOUNT=<new account id>
TOKEN=<new api token>

# 1. The application.
APP=$(curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/apps" \
  -d '{"name":"UMaTeXPRESS","domain":"umatexpress.<sub>.workers.dev","type":"self_hosted","session_duration":"8h","skip_interstitial":true,"auto_redirect_to_identity":true,"http_only_cookie_attribute":true}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).result.id))")

# 2. The allow policy (one entry per email).
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/apps/$APP/policies" \
  -d '{"name":"UMaTeXPRESS staff","decision":"allow","include":[{"email":{"email":"first@example.com"}},{"email":{"email":"second@example.com"}}]}'
```

Login-page branding (Custom Pages → login page → logo, colour, header/footer) is
dashboard work; assign the customized page inside the application.

## 7. Phase 5 — cutover checklist

- [ ] Paystack dashboard → webhook URL updated to the new host (`/api/payments/webhook`).
- [ ] `CAMPUS_APP_URL` secret points at the new host; ticket links in emails open it.
- [ ] `npm run deploy:cloudflare` on the new account lists all four cron triggers.
- [ ] Console sign-in works at `https://<new-host>/console/login` (first sign-in adopts the legacy admin credential).
- [ ] A ticket deep link opens for its owner and offers sign-in for everyone else.
- [ ] Access policy verified with a second email that should be refused.
- [ ] After a quiet week, delete the old Worker; leave the `acmdresearch` team and its applications untouched.

## 8. Rollback

The old Worker stays deployed until the checklist is done. To roll back: point
the Paystack webhook and `CAMPUS_APP_URL` at the old host again, and keep
deploying there. Nothing in Turso, Resend or Paystack has to be re-created.

## 9. What only a human can do

- Create the new Cloudflare account (email verification).
- Create the API token and pass it to the CLI.
- Choose and create the Zero Trust team in the dashboard.
- Add the staff emails to the Access policy.
