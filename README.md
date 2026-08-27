# UMaTeXPRESS

A student vacation transport booking app for UMaT-to-Accra trips. It provides live seat availability, Paystack or MTN MoMo payments, printable tickets, and an allowlisted admin dashboard.

## Requirements

- Node.js 22.13 or newer
- A Turso database
- Paystack transaction credentials, or MTN MoMo Collection API credentials

## Setup

1. Copy `.env.example` to `.env` if `.env` does not already exist.
2. Replace every placeholder in `.env` with real development credentials.
3. Install and run the app:

```sh
npm install
npm run dev
```

The checked-in `.env.example` documents all required variables. `.env` is ignored and must never be committed.

## Environment variables

- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`: Turso connection credentials.
- `PAYMENT_PROVIDER`: Use `PAYSTACK` while MTN MoMo KYC is pending, or `MTN_MOMO` later.
- `PAYSTACK_BASE_URL`: Paystack API origin. The default is `https://api.paystack.co`.
- `PAYSTACK_SECRET_KEY`: Paystack secret key from your dashboard.
- `PAYSTACK_CURRENCY`: Currency sent to Paystack. Use `GHS` for Ghana.
- `MTN_MOMO_BASE_URL`: MTN API origin. The sandbox default is included.
- `MTN_MOMO_TARGET_ENVIRONMENT`: Usually `sandbox` or the configured production environment.
- `MTN_MOMO_CURRENCY`: Use `EUR` in the MTN sandbox and the production account currency in production.
- `MTN_MOMO_API_USER`, `MTN_MOMO_API_KEY`, and `MTN_MOMO_COLLECTION_KEY`: Collection API credentials.
- `ADMIN_EMAILS`: Comma-separated email addresses allowed to sign in as administrators.
- `ADMIN_PASSWORD`: Bootstrap password for local sign-in. It defaults to `Admin@12345`; change it from the admin security page once Turso is connected.
- `ADMIN_SESSION_SECRET`: Random value of at least 32 characters used to sign HTTP-only admin sessions. Hosted workspace identity headers remain supported.

## Commands

```sh
npm run dev       # local development server
npm run lint      # ESLint validation
npm run build     # production Cloudflare/Vinext build
npm test          # production build and Node test suite
npm run start     # serve an existing production build
```

## Booking safety

Seats are held for ten minutes while payment is pending. A successful payment only confirms a booking when its hold is still valid or was already claimed by that booking. Late successful payments enter `PAYMENT_RECEIVED_REVIEW` so an administrator can assign another seat or arrange a refund.

Payment status and ticket data require a hashed, HTTP-only, per-payment browser token. Public payment responses do not expose passenger email addresses or phone numbers.
