@AGENTS.md

# Motion Gym — Frontend

Next.js 16 App Router PWA. Backend API runs on port 3001 (proxied via `/api` rewrites in `next.config.ts`).

Key files:
- `app/` — pages: `/` (schedule + unauthenticated landing), `/login`, `/register`, `/forgot`, `/admin`, `/admin/login`, `/admin/calendar`, `/admin/clients`, `/admin/history` (past days as an accordion, attendance editable), `/payment/return`, `/demo`, `not-found.tsx` (404 for any unknown URL)
- `components/` — `Header`, `MotionGymLogo`, `PageLayout`, `LoginForm` (member/admin login), `PaymentResult` (`/payment/return` status), `SwRegister`, `OfflineBanner` (sticky "Немає інтернету" strip after 5 s offline, in `app/layout.tsx`), `SlotCard` (group slot), `AssignedSlotCard` (personal / split, LiqPay), `GymLoader`, `DemoControls`, `PushSubscribeButton` (coach page), `admin/AdminMenu` (burger in the header of every coach page: Панель тренера / Клієнти / Календар / Вийти, same on phone and desktop), `admin/SlotCard`, `admin/AttendanceButton` (— → ✓ → ✗ toggle, today page and history), `admin/CancellationList` (who cancelled/moved and why: today page, calendar modal, client history)
- `lib/api.ts` — typed fetch wrapper for all backend calls
- `lib/trainingTypes.ts` — `TYPE_COLORS` for training types (calendar, history)
- `lib/liqpay.ts` — `redirectToLiqPay(slotId)` (checkout form POST), `PRICE_UAH`

Page container (`max-w-xl`, `px-5`, `pt-8 sm:pt-12 pb-12`) is defined once in `app/layout.tsx`. Pages return content directly without wrapper `<main>` tags.

Auth state: `mg_authed` key in `localStorage` — set on login, cleared on logout or 401. Used on `/` to skip the API call for unauthenticated users (avoids 401 in console).