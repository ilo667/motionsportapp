# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Motion Gym** — gym class-booking PWA. Full spec at `PROJECT_SPEC.md` (read before implementing anything). The spec uses "GymFlow" as a codename — the product name is **Motion Gym**.

## Structure

Two independent projects, no shared root `package.json`:

```
frontend/   Next.js 16 App Router — Vercel frontend project
backend/    NestJS 11 — Vercel serverless functions project
```

## Commands

### Frontend (`cd frontend`)
```bash
npm run dev        # localhost:3000
npm run build
npm run lint
```

### Backend (`cd backend`)
```bash
npm run start:dev  # localhost:3001, watch mode
npm run build      # rm -rf dist && nest build
npm run test       # Jest, matches *.spec.ts in src/
npm run test:cov
npm run db:setup   # runs sql/schema.sql then sql/seed.sql via DATABASE_URL
npm run lint
```

## Architecture

### Request flow

Frontend (`/api/*`) → Next.js rewrite → `BACKEND_URL` (dev: `localhost:3001`, prod: Vercel backend project). Backend on Vercel uses `backend/api/index.ts` as the serverless entrypoint — it lazily bootstraps NestJS and delegates requests.

### Auth

JWT in an `httpOnly` cookie (`token`). `JwtAuthGuard` reads it on protected routes. `ValidationPipe(whitelist: true)` is global. Guards: `SessionGuard` (any auth), `AdminGuard` (admin only), `MemberGuard` (member only — used on payment checkout).

Auth endpoints:
- `POST /auth/member/register` — displayName + PIN → memberCode + recoveryCode
- `POST /auth/member/login` — memberCode + PIN
- `POST /auth/member/forgot` — memberCode + recoveryCode + newPin → new recoveryCode
- `POST /auth/admin/login` — username + password
- `POST /auth/logout`
- `GET /auth/me`

### Backend modules

- `DatabaseModule` — global Drizzle ORM provider, reads `DATABASE_URL`
- `AuthModule` — member + admin auth, bcrypt passwords, JWT signing, PIN recovery
- `ScheduleModule` — `GET /schedule/next` — next training day with slots
- `BookingModule` — book / cancel / switch slot
- `AdminModule` — admin schedule management, slot cancellation, attendance
- `NotificationsModule` — push subscriptions, vacancy alerts, internal cron
- `AiModule` — AI announcement generation
- `DemoModule` — demo mode time override (`DEMO_MODE=true` env only)
- `PaymentModule` — LiqPay payment for індивідуальні/спліт slots:
  - `POST /payments/checkout` — creates booking (PENDING payment status) + returns LiqPay `{data, signature}` for form POST; if member already has a PENDING booking on that slot — reuses it with a new order_id (old payment → `REPLACED`), or returns `{status: 'PAID'}` if LiqPay says the previous attempt succeeded
  - `POST /payments/liqpay/callback` — public server-to-server callback; verifies SHA1 signature; activates/cancels booking
  - `GET /payments/status?order=` — member's own order; while PENDING asks LiqPay status API directly (used by `/payment/return`)
  - Expiry: lazily on `GET /schedule/next` (`expireStale()`), PENDING older than `PAYMENT_EXPIRY_MINUTES` — reconciles with LiqPay status API first (lost callback → PAID, LiqPay unreachable → skip)
- `HealthModule` — `GET /health`

### LiqPay — rules (verified on sandbox 2026-10-22)

The LiqPay docs are incomplete. These rules come from prod logs, so do not "fix" the code back to what the docs suggest:

- **Only documented final statuses change state.** `success`/`sandbox` → PAID; `failure`/`error`/`reversed` → FAILED (booking cancelled, seat freed). Every other status, including undocumented ones, keeps the payment PENDING until expiry. Keep it this way.
- **A declined card returns `try_again`, not `failure`.** The status API returns `result=ok status=try_again err_code=limit`. `try_again` is not in the docs. LiqPay sends **no callback** for it, and the status stays `try_again`. The order remains open for a retry on the same LiqPay page.
- **"Скасувати оплату" on LiqPay** → the status API returns `result=error err_code=payment_not_found`, and no callback is sent. Only apply a status-API response when `result === 'ok'`.
- **Decline → retry with a good card on the same page** produces a single `success` callback for the same `order_id`.
- **Callbacks are sent only for final statuses**, so never rely on them alone: `/payment/return` and `expireStale()` both reconcile through the status API (`liqpayStatus` in `liqpay.helper.ts`).
- **Test mode is defined by the keys alone** (`sandbox_…` prefix). Never send `sandbox: 1`: it forces every card to succeed and breaks the test cards for declines (`4000000000000002`).
- **`LIQPAY_SERVER_URL`** must be `https://<backend>/payments/liqpay/callback` **without `/api`**. With `/api` LiqPay gets a 404 and payments hang in PENDING. **`FRONTEND_URL`** is required, otherwise LiqPay shows no "back to site" button (`result_url` ends up relative).
- **`server_url` is embedded in each order.** After changing the env var, old orders keep retrying the old URL; this is harmless.
- **Testing:** set `PAYMENT_EXPIRY_MINUTES=2` on Vercel for expiry scenarios, then remove it. Vercel Hobby keeps runtime logs only ~30 min (`vercel logs` without `--since`), so check them right after the scenario. The LiqPay cabinet → payment → "Лог виклику API" keeps callback history.
- **Logs:** every payment decision is logged (`Checkout:`, `LiqPay callback:`, `LiqPay status API:`, `Status check:`, `Expire:`). LiqPay payloads are logged as a safe field subset plus `keys=[…]`; never log names, phones or card masks.

### Database

Drizzle ORM over Neon (PostgreSQL). Schema in `backend/src/database/schema.ts`, SQL migrations in `backend/sql/`. Run `npm run db:setup` to apply schema + seed.

### Frontend conventions

- All backend calls go through `frontend/lib/api.ts` (typed fetch wrapper, `credentials: 'include'`)
- Tailwind CSS v4 — design tokens defined inline in `globals.css` under `@theme`. Use named tokens (`text-accent`, `bg-teal`, `text-muted`, etc.), not arbitrary hex values
- **No `gap-*`** — use `space-y-*` (flex-col), `space-x-*` (inline), or `-m-1`/`m-1` trick for flex-wrap. Pre-commit hook enforces this.
- Fonts: Inter (body, `--font-inter`), Rubik 700 (headings, `--font-geologica`). Use `font-geologica` utility class for headings.
- Logo component: `MotionGymLogo`
- Layout: `app/layout.tsx` provides the outer flex container (`max-w-xl`, `px-5`). Pages use `PageLayout` component:
  - `variant="centered"` (default) — logo + vertically centered content (auth/landing pages)
  - `variant="top"` — mini `Header` (logo + optional `action`) + content below (schedule/admin pages)
  - `loading` prop — shows `GymLoader` instead of children
- Auth state: `mg_authed` in `localStorage` — set on login, cleared on logout/401. Home page skips API call when flag is absent (avoids 401 in console for unauthenticated users)

## Vercel deployment

Two separate Vercel projects pointing at this repo:
- **frontend project** — root: `frontend/`
- **backend project** — root: `backend/`, entry: `api/index.ts`, rewrites all to `/api`

Required env vars:
- Backend: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`
- Backend (payments): `LIQPAY_PUBLIC_KEY`, `LIQPAY_PRIVATE_KEY`, `LIQPAY_SERVER_URL`, `LIQPAY_AMOUNT` (default `700`), `PAYMENT_EXPIRY_MINUTES` (default `15`; set e.g. `2` to test expiry)
- Frontend: `BACKEND_URL`