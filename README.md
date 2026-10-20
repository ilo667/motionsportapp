# Motion Gym — Sports Performance PWA

Full-stack sports performance app. Users complete a short assessment and receive a personalised performance result.

**Stack:** NestJS · Next.js App Router · PostgreSQL · Tailwind CSS v4 · Vercel

---

## Architecture

```
motionsportapp/
├── frontend/   # Next.js 16 (App Router) — deployed as Vercel frontend project
└── backend/    # NestJS 11 — deployed as Vercel serverless functions project
```

The two Vercel projects share a single git repository. The frontend proxies `/api/*` requests to the backend via `next.config.ts` rewrites.

---

## Data model

| Table | Purpose |
|-------|---------|
| `users` | Registered users (email + bcrypt password hash) |
| `quiz_versions` | Assessment versions; only one is active at a time |
| `questions` | Questions belonging to a version |
| `quiz_attempts` | Submitted attempts with score and result (`HIGH` / `LOW`) |
| `answers` | Individual answer values (0–4) per attempt |

---

## Auth flow

- JWT stored in an **httpOnly cookie** (XSS-safe)
- Anonymous-first: assessment is submitted before registration; the `attemptToken` UUID is stored in `localStorage` and linked on register

---

## Local dev

```bash
# Backend (port 3001)
cd backend && npm install && npm run start:dev

# Frontend (port 3000)
cd frontend && npm install && npm run dev
```

Copy `backend/.env.example` → `backend/.env` and set `DATABASE_URL` and `JWT_SECRET`.

---

## Database setup

```bash
cd backend && npm run db:setup
```

Runs `sql/schema.sql` then `sql/seed.sql` against `DATABASE_URL`.

---

## Deployment

Two separate Vercel projects, both pointing at this repository:

- **motionsport** — root: `frontend/`
- **motionsport-api** — root: `backend/`

Set `FRONTEND_URL` and `BACKEND_URL` env vars in each Vercel project's settings.