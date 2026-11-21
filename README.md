# wedplan-server

Express + MongoDB REST API for **WedPlan**, a wedding-planning platform. It owns
all data and business rules — role-based access control, service moderation,
booking lifecycle, Stripe premium subscriptions, and ImgBB image uploads — and
serves the separate Next.js client (`wedplan-client`).

## Features

- **JWT authentication bridge** — Better Auth signs users in on the client; this
  server verifies the signed session cookie (`BETTER_AUTH_SECRET`) and mints
  short-lived API JWTs (`POST /api/auth/token`). Every protected route requires
  `Authorization: Bearer <token>`.
- **Role-based authorization** — `customer`, `vendor`, `admin` roles verified
  server-side on every protected endpoint (`403` otherwise). Blocked users are
  locked out immediately, whatever their role. Admin can never be assigned
  through the API.
- **Services** — public browse with search (name/description/vendor), category
  and location filters, and price sort ascending/descending. Vendor CRUD with a
  3-active-listing cap on the free plan; new listings start `pending` and are
  hidden until an admin approves them.
- **Bookings** — customers request bookings; no self-booking, no duplicates per
  service + event date, and only `pending` requests can be accepted, rejected,
  or cancelled (each by the right party).
- **Admin** — user management (block/unblock, role changes short of admin),
  service moderation (approve/reject), stats, and a **view-only** transactions
  ledger.
- **Stripe premium** — `POST /api/payments/checkout` creates a Checkout session;
  the **raw-body webhook** (`/api/payments/webhook`, signature-verified) is the
  only thing that activates premium (30 days) and writes the transaction. The
  client success redirect never trusts itself.
- **ImgBB uploads** — `POST /api/profile/image` for profile pictures.
- **Graceful degradation** — with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  or `IMGBB_API_KEY` missing, the related endpoints return a clear `503`
  explaining which env var to set instead of crashing.

## Tech stack

- **Runtime:** Node.js (ES modules), Express 5
- **Database:** MongoDB (`mongodb` driver) — database `wed-plan`, shared with
  the client's Better Auth collections (`user`, `session`, `account`)
- **Auth:** JWT (`jsonwebtoken`) + HMAC verification of Better Auth session
  cookies; password hashing compatible with Better Auth (`@better-auth/utils`)
- **Payments:** Stripe Checkout (`stripe`)
- **Images:** ImgBB REST API
- **Testing:** `scripts/smoke-test.mjs` — 46 end-to-end checks that sign in
  through the real client and assert every business rule

## API overview

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | public | liveness |
| POST | `/api/auth/token` | session cookie | exchange for API JWT |
| GET | `/api/auth/me` | authenticated | live profile + role |
| GET | `/api/services` | public | browse: `search`, `category`, `location`, `sort=price_asc\|price_desc`, `page` |
| GET | `/api/services/featured` | public | up to 6 featured listings |
| GET | `/api/services/:id` | public/optional auth | detail (hidden services 404) |
| GET/POST | `/api/vendor/services` | vendor, admin | list own / create (pending, free-plan cap) |
| PUT/DELETE | `/api/vendor/services/:id` | owner, admin | edit / remove |
| POST | `/api/bookings` | authenticated | request booking (self → 400, dup → 409) |
| GET | `/api/bookings/mine` | authenticated | own bookings (customer view) |
| GET | `/api/bookings/requests` | vendor, admin | incoming requests |
| PATCH | `/api/bookings/:id` | owner parties | accept/reject (vendor) · cancel (customer) — pending only |
| PATCH | `/api/profile` | authenticated | update own profile (no role/plan self-promotion) |
| POST | `/api/profile/image` | authenticated | ImgBB upload |
| POST | `/api/payments/checkout` | authenticated | Stripe Checkout session |
| GET | `/api/payments/status` | authenticated | verify a session with Stripe |
| POST | `/api/payments/webhook` | Stripe signature | **only** path that activates premium |
| GET | `/api/admin/stats` | admin | dashboard counters |
| GET/PATCH | `/api/admin/users[/:id]` | admin | list · block/unblock · role (never admin) |
| GET | `/api/admin/services` | admin | every listing incl. unapproved |
| PATCH | `/api/admin/services/:id` | admin | `approve` / `reject` |
| GET | `/api/admin/transactions` | admin | view-only ledger |

All error responses are `{ "error": "<message>" }` with proper `401`/`403`/`404`/
`409`/`503` status codes.

## Getting started

### 1. Install

```bash
git clone <repo-url> wedplan-server
cd wedplan-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env` (never commit it — it is git-ignored):

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | ✅ | MongoDB connection string (same DB the client's Better Auth uses) |
| `JWT_SECRET` | ✅ | shared with the client — signs/verifies API JWTs |
| `BETTER_AUTH_SECRET` | ✅ | same value as the client's — verifies session cookies |
| `PORT` | — | default `8000` |
| `CLIENT_URL` | — | Next.js origin for CORS + Stripe redirects, default `http://localhost:3000` |
| `JWT_EXPIRES_IN` | — | API token lifetime, default `1h` |
| `STRIPE_SECRET_KEY` | for payments | Stripe secret key (test mode ok) |
| `STRIPE_WEBHOOK_SECRET` | for payments | webhook signing secret (raw-body verification) |
| `IMGBB_API_KEY` | for uploads | ImgBB API key |

### 3. Seed demo data (optional)

```bash
node scripts/seed.js
```

Repeatable and idempotent — resets demo users and services (and removes legacy
client-seeded rows). Demo sign-ins (password `Wedplan1!`):

| Role | Email | Notes |
| --- | --- | --- |
| admin | `admin@wedplan.test` | |
| vendor | `vendor@wedplan.test` | free plan, already at the 3-service cap |
| vendor | `vendor2@wedplan.test` | premium plan |
| customer | `customer@wedplan.test` | |
| blocked | `blocked@wedplan.test` | blocked account — sign-in refused |

### 4. Run

```bash
node index.js        # or: npm start
# wedplan-server listening on http://localhost:8000
```

### 5. Verify

With the server **and** the client (`wedplan-client`, port 3000) running:

```bash
node scripts/smoke-test.mjs
# 46 passed, 0 failed
```

## Project structure

```
index.js               entry — env check, DB connect, listen
src/
  config/env.js        env loading + required-variable guard
  config/db.js         Mongo connection + indexes
  config/categories.js the six canonical service categories
  middleware/auth.js   JWT sign/verify, requireRole, optionalAuth
  middleware/error.js  ApiError + central JSON error handler
  routes/auth.js       session-cookie → API JWT exchange, /me
  routes/services.js   public browse + vendor CRUD + ownership checks
  routes/bookings.js   booking rules (self/duplicate/status transitions)
  routes/admin.js      users, moderation, transactions, stats
  routes/payments.js   Stripe checkout + raw-body webhook + status
  routes/profile.js    profile updates + ImgBB upload
  app.js               Express app, CORS, route table
scripts/
  seed.js              repeatable demo seed
  smoke-test.mjs       46-check end-to-end suite
```

## Related repositories

- **Client:** `wedplan-client` — Next.js 16 (App Router) UI, Better Auth
  sign-in, role dashboards.
