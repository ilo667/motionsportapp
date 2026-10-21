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
  - Expiry: lazily on `GET /schedule/next` (`expireStale()`), PENDING older than 15 min — reconciles with LiqPay status API first (lost callback → PAID, LiqPay unreachable → skip)
- `HealthModule` — `GET /health`

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
- Backend (payments): `LIQPAY_PUBLIC_KEY`, `LIQPAY_PRIVATE_KEY`, `LIQPAY_SERVER_URL`, `LIQPAY_AMOUNT` (default `700`)
- Frontend: `BACKEND_URL`