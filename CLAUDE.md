# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**MotionSport** — gym class-booking PWA. Full spec at `PROJECT_SPEC.md` (read before implementing anything). The spec uses "GymFlow" as a codename — the product name is **MotionSport**.

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

JWT in an `httpOnly` cookie (`token`). `JwtAuthGuard` reads it on protected routes. `ValidationPipe(whitelist: true)` is global. Auth endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/customer`.

### Backend modules

- `DatabaseModule` — global `pg.Pool` provider, reads `DATABASE_URL`
- `AuthModule` — register/login/logout/me, bcrypt passwords, JWT signing
- `QuizModule` — `GET /quiz/active`, `POST /quiz/attempts`

### Database

Raw SQL via `pg` (no ORM). Schema in `backend/sql/schema.sql`, seed in `backend/sql/seed.sql`. Run both with `npm run db:setup`. Anonymous-first flow: attempts carry a UUID `attempt_token` stored in `localStorage`, linked to a user on registration via `POST /auth/link-attempt`.

### Frontend conventions

- All backend calls go through `frontend/lib/api.ts` (typed fetch wrapper, `credentials: 'include'`)
- Tailwind CSS v4 — design tokens defined inline in `globals.css` under `@theme`. Use named tokens (`text-accent`, `bg-teal`, `text-muted`, etc.), not arbitrary hex values
- Fonts: Inter (body, `--font-inter`), Geologica (headings, `--font-geologica`). Use `font-geologica` utility class for headings
- Logo component: `MotionSportLogo` (placeholder PNGs — replace before launch)

## Vercel deployment

Two separate Vercel projects pointing at this repo:
- **frontend project** — root: `frontend/`
- **backend project** — root: `backend/`, entry: `api/index.ts`, rewrites all to `/api`

Required env vars:
- Backend: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`
- Frontend: `BACKEND_URL`