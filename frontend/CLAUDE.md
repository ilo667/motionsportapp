@AGENTS.md

# MotionSport — Frontend

Next.js 16 App Router PWA. Backend API runs on port 3001 (proxied via `/api` rewrites in `next.config.ts`).

Key files:
- `app/` — pages (landing, quiz, register, login, report)
- `components/` — shared UI (Header, Footer, MotionSportLogo, AuthCard, SignOutButton)
- `lib/api.ts` — typed fetch wrapper for all backend calls