# WedPlan Server — REST API

## Project Name and Description

**Project name:** WedPlan Server — REST API. Express + MongoDB REST API for **WedPlan**, a wedding-planning platform. It owns all data and business rules — role-based access control, service moderation, booking lifecycle, Stripe premium subscriptions, and ImgBB image uploads — and serves the separate Next.js client.

## Live Website Link

- **Client:** <https://wedplan-client-brown.vercel.app>
- **API:** <https://wedplan-server-teal.vercel.app>
- **API health check:** <https://wedplan-server-teal.vercel.app/api/health>

## Client and Server Repository Links

- **Client repository:** <https://github.com/Gourbera-sudo/wed-plan-client.git>
- **Server repository:** <https://github.com/Gourbera-sudo/wedplan-server.git> — this repository.

## Important Features

- **JWT authentication bridge** — Better Auth signs users in on the client domain; the client's same-origin `/api/auth/token` route reads that session and signs a short-lived HS256 JWT with the shared `JWT_SECRET`. Every protected API route verifies `Authorization: Bearer <token>` against that secret, so cross-domain hosting works without shipping cookies to the API.
- **Role-based authorization** — `customer`, `vendor`, `admin` roles verified server-side on every protected endpoint (`403` otherwise). Blocked users are locked out immediately, whatever their role. Admin can never be assigned through the API.
- **Services** — public browse with search (name/description/vendor), category and location filters, and price sort ascending/descending. Vendor CRUD with a 3-active-listing cap on the free plan; new listings start `pending` and are hidden until an admin approves them.
- **Bookings** — customers request bookings; no self-booking, no duplicates per service + event date, and only `pending` requests can be accepted, rejected, or cancelled (each by the right party).
- **Admin** — user management (server-side search/role filters, detail view, block/unblock, role and business-name changes short of admin — no plan grants), service moderation with server-side filters (approve/reject/pause/delete), stats, and a transaction ledger with vendor identity and UPI verification.
- **Stripe premium** — `POST /api/payments/checkout` is vendor-only and creates a Checkout session; the **raw-body webhook** (`/api/payments/webhook`, signature-verified) is the trusted event that activates premium (30 days) and writes the transaction. Redeliveries are idempotent; refunds, disputes, and cancellations revoke premium. The client success redirect never trusts itself, and expired premium automatically falls back to the free-plan limit.
- **UPI premium** — `POST /api/payments/upi/create` returns a QR/deep link and pending reference; `POST /api/payments/upi/submit` records the vendor's UTR. Premium activates only through the admin-only `PATCH /api/admin/transactions/:ref/verify`; polling and redirects never change the plan.
- **ImgBB uploads** — `POST /api/profile/image` for profile pictures.
- **Graceful degradation** — with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `UPI_VPA`, or `IMGBB_API_KEY` missing, the related endpoints return a clear `503` explaining which env var to set instead of crashing.

## Technology Stack

- **Runtime:** Node.js (ES modules), Express 5
- **Database:** MongoDB (`mongodb` driver) — database `wed-plan`, shared with the client's Better Auth collections (`user`, `session`, `account`)
- **Auth:** JWT (`jsonwebtoken`) verified with the shared `JWT_SECRET`; password hashing compatible with Better Auth (`@better-auth/utils`)
- **Payments:** Stripe Checkout (`stripe`)
- **Images:** ImgBB REST API
- **Testing:** `scripts/smoke-test.mjs` — 62 end-to-end checks that sign in through the real client and assert every business rule

## API Overview

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | public | liveness |
| POST | `/api/auth/token` | session cookie | exchange for API JWT |
| GET | `/api/auth/me` | authenticated | live profile + role + effective plan |
| GET | `/api/services` | public | browse: `search`, `category`, `location`, `sort=price_asc\|price_desc`, `page` |
| GET | `/api/services/featured` | public | up to 6 featured listings |
| GET | `/api/services/:id` | public/optional auth | detail (hidden services 404) |
| GET/POST | `/api/vendor/services` | vendor, admin | list own / create (pending, free-plan cap) |
| PUT/DELETE | `/api/vendor/services/:id` | owner, admin | edit / remove |
| POST | `/api/bookings` | authenticated | request booking (self → 400, dup → 409) |
| GET | `/api/bookings/mine` | authenticated | own bookings (customer view) |
| GET | `/api/bookings/requests` | vendor | incoming requests |
| PATCH | `/api/bookings/:id` | owner parties | accept/reject (vendor) · cancel (customer) — pending only |
| PATCH | `/api/profile` | authenticated | update own profile (no role/plan self-promotion) |
| POST | `/api/profile/image` | authenticated | ImgBB upload |
| POST | `/api/payments/checkout` | vendor | Stripe Checkout session |
| GET | `/api/payments/status` | authenticated | verify a session with Stripe |
| POST | `/api/payments/webhook` | Stripe signature | verified event: activates, expires, or revokes premium |
| POST | `/api/payments/upi/create` | vendor | create a pending UPI order + QR/deep link |
| POST | `/api/payments/upi/submit` | vendor | record the UTR (status becomes `verifying`) |
| GET | `/api/payments/upi/status` | authenticated | poll a UPI order (never activates) |
| GET | `/api/admin/stats` | admin | dashboard counters |
| GET | `/api/admin/users` | admin | list accounts; `search`, `role` filters |
| GET/PATCH | `/api/admin/users/:id` | admin | detail · block/unblock · role (never admin) · business name (no plan grant) |
| GET | `/api/admin/services` | admin | every listing incl. unapproved; `search`, `category`, `status`, `isActive` filters |
| PATCH | `/api/admin/services/:id` | admin | `approve` / `reject` |
| PATCH | `/api/admin/services/:id/status` | admin | pause / reactivate, approval unchanged |
| DELETE | `/api/admin/services/:id` | admin | permanently remove a listing |
| GET | `/api/admin/transactions` | admin | full ledger |
| PATCH | `/api/admin/transactions/:ref/verify` | admin | `approve` / `reject` a UPI payment — the trusted activation event |

All error responses are `{ "error": "<message>" }` with proper `401`/`403`/`404`/`409`/`503` status codes.

## Installation Instructions

Requires Node.js 20+ and a MongoDB connection (local or Atlas).

### 1. Clone and install dependencies

```bash
git clone https://github.com/Gourbera-sudo/wedplan-server.git wedplan-server
cd wedplan-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env   # never commit .env — it is git-ignored
```

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | ✅ | MongoDB connection string (same DB the client's Better Auth uses) |
| `JWT_SECRET` | ✅ | shared with the client — signs/verifies API JWTs |
| `BETTER_AUTH_SECRET` | ✅ | same value as the client's — verifies session cookies |
| `PORT` | — | default `8000` |
| `CLIENT_URL` | — | Next.js origin for CORS + Stripe redirects, default `http://localhost:3000` |
| `JWT_EXPIRES_IN` | — | API token lifetime, default `1h` |
| `ADMIN_PASSWORD` | — | Password applied to seeded demo accounts (including admin) by `scripts/seed.js`, default `Wedplan1!`; must be 6+ chars with upper and lower |
| `STRIPE_SECRET_KEY` | for payments | Stripe secret key (test mode ok) |
| `STRIPE_WEBHOOK_SECRET` | for payments | webhook signing secret (raw-body verification) |
| `UPI_VPA` | for UPI | payee UPI ID shown on the QR/deep link; empty disables UPI |
| `UPI_PAYEE_NAME` | — | display name on the payment link, default `WedPlan` |
| `UPI_MONTHLY_PAISE` | — | 30-day premium price in paise, default `49900` (₹499) |
| `IMGBB_API_KEY` | for uploads | ImgBB API key |

### 3. Seed demo data (optional)

```bash
node scripts/seed.js
```

Repeatable and idempotent — resets demo users and services (and removes legacy client-seeded rows). The password comes from `ADMIN_PASSWORD` in `.env` (default `Wedplan1!`); re-run the seed after changing it. Demo sign-ins:

| Role | Email | Notes |
| --- | --- | --- |
| admin | `admin@wedplan.test` | |
| vendor | `vendor@wedplan.test` | free plan, already at the 3-service cap |
| vendor | `vendor2@wedplan.test` | premium plan |
| customer | `customer@wedplan.test` | |
| blocked | `blocked@wedplan.test` | blocked account — sign-in refused |

## How to Run the Project Locally

Start the API from this repository:

```bash
cd wedplan-server
npm start               # or: node index.js
# wedplan-server listening on http://localhost:8000
```

Then start the client from the sibling repository in a second terminal:

```bash
cd ../wedplan-client
npm run dev             # http://localhost:3000
```

Verify the full stack with the smoke suite while both processes are running:

```bash
cd ../wedplan-server
npm test
# 62 passed, 0 failed
```

If you have bookings created by the old client-side server action, normalize them once before running the suite:

```bash
node scripts/migrate-bookings.mjs
```

It converts string IDs and capitalized statuses to the current schema and fills missing denormalized display fields. It is safe to re-run.

## Deployment

The live API is a Vercel project (`wedplan-server`) with `vercel.json` routing every request through `api/index.js`, where the Express app is cached between invocations and Stripe's raw webhook body is preserved. Deployment Protection is disabled so public routes are reachable without Vercel SSO. Production env vars include the shared MongoDB URI, `JWT_SECRET`, `BETTER_AUTH_SECRET`, `CLIENT_URL=https://wedplan-client-brown.vercel.app`, and UPI settings. Stripe and ImgBB keys are not part of this demo deployment; their endpoints return a clear `503` until configured. Redeploy with `vercel --prod`, then confirm `/api/health` and `/api/services` respond publicly.

## Project Structure

```
index.js               entry — env check, DB connect, listen
api/index.js           Vercel serverless handler (cached Express app)
vercel.json            Vercel builds, routes, and iad1 function region
src/
  config/env.js        env loading + required-variable guard
  config/db.js         Mongo connection + indexes
  config/categories.js the six canonical service categories
  middleware/auth.js   JWT sign/verify, requireRole, optionalAuth
  middleware/error.js  ApiError + central JSON error handler
  lib/subscription.js  effective plan (expired premium → free)
  routes/auth.js       session-cookie → API JWT exchange, /me
  routes/services.js   public browse + vendor CRUD + ownership checks
  routes/bookings.js   booking rules (self/duplicate/status transitions)
  routes/admin.js      users, moderation, transactions, stats
  routes/payments.js   Stripe checkout + raw-body webhook + status
  routes/profile.js    profile updates + ImgBB upload
  app.js               Express app, CORS, route table
scripts/
  seed.js              repeatable demo seed
  smoke-test.mjs       62-check end-to-end suite
  migrate-bookings.mjs one-time legacy booking normalization
```
