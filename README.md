# Motion Gym

Gym booking and membership PWA. Members book group trainings and buy club cards and training passes (online through LiqPay, or cash to their trainer). Trainers manage their own schedule, calendar, clients, attendance and payments. Several trainers can work at the same time in different halls.

**Stack:** NestJS 11 · Next.js 16 App Router · PostgreSQL (Neon) + Drizzle ORM · Tailwind CSS v4 · Vercel

Detailed rules for working on the code are in [CLAUDE.md](CLAUDE.md); the manual test checklist is in [TESTING.md](TESTING.md); the original v1 product spec is [PROJECT_SPEC.md](PROJECT_SPEC.md).

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

- **Members:** sign up with a name and a 6-digit PIN (member code + recovery code).
  - Book a group training while its booking is open: from the trainer's opening time on the training day until the training starts. One group booking a day; move to another time with a reason; bring one guest.
  - Get push alerts when a seat frees up, and see the personal / split trainings the trainer assigned to them.
  - Buy a club card, trainings with the trainer and group passes («Мій абонемент»), online or in cash. A card starts when the trainer activates it, a pass on the first training; a pass burns if not started within a month.
  - Freeze the membership for up to 30 days (the trainer approves). A late cancellation can cost the training; for a single personal training cancelled 2–24 hours ahead, half the price comes back.
- **Trainers** (each sees only their own trainings and clients):
  - Weekly schedule of group trainings («Розклад групових»: own days, times and booking opening time). Calendar with group, personal and split trainings.
  - Today's trainings with attendance, and history with editable attendance.
  - Clients with notes, reassigning, cancellation reasons and freeze requests. Confirming cash payments.
  - One shared price list with change history; revenue and load statistics. Inviting new trainers by link.
- **Automatic:** each trainer's group trainings appear three weeks ahead from their weekly schedule; a push when booking opens; AI writes the daily announcement from the weekly programme.

---

## Data model (main tables)

| Table | Purpose |
|-------|---------|
| `members` | Clients: member code, name, PIN and recovery hashes, trainer (`trainer_id`), trainer-only note |
| `admins`, `trainer_invites` | Trainer accounts and one-time invite links |
| `sessions` | Login sessions (SHA-256 of the cookie token) for members and trainers |
| `trainer_schedules`, `trainer_schedule_times` | A trainer's weekly group schedule and booking opening time |
| `training_days` / `training_slots` | Training dates and their trainings (time, type `group` / `personal` / `split`, capacity, owner trainer) |
| `slot_members` | Who a personal / split training is for |
| `bookings`, `booking_guests` | Bookings (with cancellation reason, move target, late-cancellation fee) and their guests |
| `attendance` | Present / absent marks |
| `price_items`, `price_changes` | Shared price list and who changed what |
| `purchases`, `purchase_items` | A client's purchase (LiqPay or cash) and its lines with the prices of that moment |
| `club_cards`, `packages`, `package_spends` | What a paid purchase gives: gym access dates, training passes, trainings spent by attendance marks |
| `payments` | LiqPay payments of purchases |
| `freezes`, `freeze_items` | Membership freezes and the dates they moved |
| `cancel_refunds` | Half refunds owed after a late cancellation |
| `announcements`, `announcement_examples`, `ai_generations` | Daily announcement, examples for the AI, generation log |
| `push_subscriptions`, `admin_push_subscriptions`, `vacancy_alerts`, `notification_events` | Push notifications |

The schema lives in `backend/src/database/schema.ts`.

---

## Auth

An opaque session token in an `httpOnly` cookie named `session` (no JWT). The database keeps only its hash; logout revokes it. Clients log in with member code + PIN, trainers with username + password; new trainers join by an invite link.

---

## Local dev

```bash
cp backend/.env.example backend/.env           # fill in DATABASE_URL at least
cp frontend/.env.example frontend/.env.local

# Backend (port 3001)
cd backend && npm install && npm run start:dev

# Frontend (port 3000)
cd frontend && npm install && npm run dev
```

Every environment variable is listed with a comment in `backend/.env.example`; only `DATABASE_URL` and `FRONTEND_URL` are needed to run locally.

## Database

```bash
cd backend
npm run db:push      # apply src/database/schema.ts to DATABASE_URL (drizzle-kit)
npm run seed:prices  # fill the price list
ADMIN_USERNAME=trainer ADMIN_PASSWORD=<long password> npm run seed:admin   # create the first trainer account
```

## Tests

```bash
cd backend && npm test     # Jest
cd frontend && npm test    # Vitest
```

---

## Deployment

Two Vercel projects pointing at this repository:

- **frontend**: root `frontend/`, env `BACKEND_URL`
- **backend**: root `backend/`, env vars as in `backend/.env.example`; crons are in `backend/vercel.json`
