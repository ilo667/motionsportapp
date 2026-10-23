# Motion Gym

Gym class-booking PWA. Clients book group trainings (Mon / Wed / Fri, 19:00 and 20:00) and buy club cards and trainer packages (LiqPay or cash to their trainer); trainers manage their calendar, clients, attendance and history.

**Stack:** NestJS 11 · Next.js 16 App Router · PostgreSQL (Neon) + Drizzle ORM · Tailwind CSS v4 · Vercel

Detailed rules for working on the code are in [CLAUDE.md](CLAUDE.md); the manual test checklist is in [TESTING.md](TESTING.md); the original product spec is [PROJECT_SPEC.md](PROJECT_SPEC.md).

---

## Structure

```
motionsportapp/
├── frontend/   # Next.js PWA, Vercel frontend project
└── backend/    # NestJS API, Vercel serverless project (entry: backend/api/index.ts)
```

The frontend proxies `/api/*` to the backend (`BACKEND_URL`) via `next.config.ts` rewrites.

---

## Main features

- **Clients:** sign up with a name and a 6-digit PIN (member code + recovery code); book a group training in the 14:00–21:00 window with a group pass (single visit or 10, bought right from «Записатись»; one group booking per day), cancel or move between 19:00 and 20:00 with a reason, get push alerts when a seat frees up; see the personal / split trainings the trainer assigned to them; buy a club card, packages of trainings with the trainer and group passes («Мої покупки»), by LiqPay or cash; a card starts when the trainer activates it, a package on the first training, and burns if not started within a month.
- **Trainers** (each sees only their own data): calendar (group, personal, split), today's trainings with attendance, history with editable attendance, clients with notes and reassigning to another trainer, cancellation reasons, push when a client cancels; confirm cash payments, see each client's card and trainings left; one shared price list («Ціни») with change history.
- **Automatic:** group trainings on Mon / Wed / Fri appear by themselves three weeks ahead; AI writes the daily announcement using the weekly programme (Mon legs, Wed circuit, Fri arms).

---

## Data model (main tables)

| Table | Purpose |
|-------|---------|
| `members` | Clients: member code, name, PIN and recovery hashes, trainer (`trainer_id`), trainer-only note |
| `admins` | Trainer accounts |
| `sessions` | Login sessions (SHA-256 of the cookie token) for members and trainers |
| `training_days` / `training_slots` | Training dates and their trainings (time, type, capacity, owner trainer) |
| `slot_members` | Who a personal / split training is for |
| `bookings` | Bookings, with cancellation reason and move target |
| `price_items`, `price_changes` | Shared price list and who changed what |
| `purchases`, `purchase_items` | A client's purchase (LiqPay or cash) and its lines with the prices of that moment |
| `club_cards`, `packages`, `package_spends` | What a paid purchase gives: gym access dates, trainings with the trainer, trainings spent by attendance marks |
| `payments` | LiqPay payments of purchases (older ones: of single trainings) |
| `attendance` | Present / absent marks |
| `announcements`, `announcement_examples`, `ai_generations` | Daily announcement, examples for the AI, generation log |
| `push_subscriptions`, `admin_push_subscriptions`, `vacancy_alerts`, `notification_events` | Push notifications |

The schema lives in `backend/src/database/schema.ts`.

---

## Auth

An opaque session token in an `httpOnly` cookie named `session` (no JWT). The database keeps only its hash; logout revokes it. Clients log in with member code + PIN, trainers with username + password.

---

## Local dev

```bash
# Backend (port 3001)
cd backend && npm install && npm run start:dev

# Frontend (port 3000)
cd frontend && npm install && npm run dev
```

Create `backend/.env` with at least `DATABASE_URL` and `FRONTEND_URL`; the full list of environment variables is in CLAUDE.md → "Vercel deployment".

## Database

```bash
cd backend
npm run db:push      # apply src/database/schema.ts to DATABASE_URL (drizzle-kit)
ADMIN_USERNAME=trainer ADMIN_PASSWORD=<long password> npm run seed:admin   # create a trainer account
```

## Tests

```bash
cd backend && npm test
```

---

## Deployment

Two Vercel projects pointing at this repository:

- **frontend** — root `frontend/`, env `BACKEND_URL`
- **backend** — root `backend/`, env vars listed in CLAUDE.md; crons are in `backend/vercel.json`
