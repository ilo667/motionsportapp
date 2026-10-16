# GymFlow — PROJECT_SPEC.md

> Product requirements, architecture, implementation contract and delivery plan for Claude Code.
> Language of the product: Ukrainian. Technical naming/code: English.
> Status: specification only. **Do not implement code until explicitly instructed.**
> Version: 1.1 — 2026-10-16 (expanded post-MVP AI Engineering roadmap).

## 0. Instructions for Claude Code (read first)

You are implementing **GymFlow**, a small-gym class-booking Progressive Web App, initially a portfolio showcase and later a real service. **Respect confirmed decisions** in this document. Do not introduce features that were rejected or deferred. Build iteratively, in small reviewable phases, and explain key NestJS/TypeScript architectural choices to the project owner as you go. Ask only when a genuine product decision is blocking; otherwise choose the simplest maintainable technical solution and document it.

**Do not start coding solely because this specification is supplied.** Wait for an explicit instruction such as “implement Phase 1.” At implementation time: propose a concise phase plan, show the files you will create/change, implement one phase, run lint/typecheck/tests, report results, and wait for approval before continuing. Do not claim something was tested if it was not.

Priorities: (1) correct transactional booking and privacy, (2) simple mobile UX, (3) reliability, (4) clear AI integration and observable LLMOps, (5) portfolio quality without overengineering. All booking logic is deterministic; **AI must never decide bookings, capacity, schedules or permissions**.

### Decision provenance

- **CONFIRMED** = agreed product behavior; do not change without asking.
- **PROPOSED IMPLEMENTATION** = recommended engineering detail; validate against platform constraints and adjust if needed without changing product behavior.
- **TODO / POST-MVP** = explicitly not in MVP.

## 1. Product and MVP scope

GymFlow replaces informal Viber voting for a small gym. A client signs in, sees the nearest training day and the two groups (19:00 and 20:00), views counts (not others' names), books or switches one slot, and optionally subscribes to a free-seat alert. One coach/admin manages exceptions to the regular schedule, cancels groups, confirms attendance and edits AI-written motivational announcements.

Initially a **portfolio app**, with an isolated interactive demo; later intended for **real gym usage**. No calendar UI, payments, memberships, attendance QR, multi-admin management, client history dashboard, or manual coach manipulation of individual bookings in MVP.

### Roles

1. **Member/client:** free self-registration; view protected schedule and counts; manage only own booking; opt in/out of free-seat push; see own booking state.
2. **Coach/admin:** one account for MVP, **separate username/password sign-in** and admin panel; edit schedule exceptions, enable/disable slots, see participants' names, mark attendance, manage announcement examples/topics/text. Cannot manually add or remove individual bookings.
3. **Unauthenticated visitor:** only registration and login screens. Neither schedule nor counts are public.

## 2. Canonical time and schedule rules (CONFIRMED)

- All business dates/times use **Europe/Kyiv** and correct DST handling. Persist instants in UTC and use local-date identifiers for gym days. Do not hardcode `UTC+2` or `UTC+3`.
- Default training days: **Monday, Wednesday, Friday**.
- Coach can **cancel a scheduled day**, **add a training day on another date**, and cancel either slot independently. Coach cannot change the fixed slot times.
- Exactly **two fixed slots** per training day: **19:00** and **20:00**. Both are enabled by default.
- Booking opens at **14:00 on the same local date** for enabled slots. Coach has the ability to manually open booking when needed; clarify exact override UX in implementation only if unavoidable. Do not silently permit opening earlier for normal clients without an explicit admin override.
- **Both slots lock at 21:00 on that date** (not per-slot 19:05/20:05). Before 21:00, members may book, cancel or switch even after a session has started. This is intentional.
- **Max 8** active bookings per slot, hard limit enforced transactionally.
- **Max 1 active slot per member per training date**.
- **3 members** is an informational minimum, **not** an automatic cancellation trigger. If 1–2 attend, the coach decides whether the class runs.
- Coach may cancel an entire slot: its active bookings are cancelled and affected members receive cancellation push (subject to permission/delivery). No automatic transfer to another slot. The other slot stays available if enabled.
- Coach may cancel an entire training day: both slots are cancelled with the same notification behavior.
- A disabled/cancelled slot is visibly labelled as cancelled; cannot be booked.
- Admin's schedule exceptions must affect the next-training-day calculation.

### Post-21:00 presentation (PROPOSED IMPLEMENTATION)

Show the next scheduled training date after 21:00, rather than a stale bookable-looking card. Keep historical data in the database; there is no client history UI in MVP.

### Important edge cases

- All slot/booking mutations must validate authoritative server time, role, local training date, slot status, capacity and one-booking-per-day rule.
- A simultaneous booking for the last seat must produce exactly one success; others receive a clear `409` response and updated count.
- Switching from 19:00 to 20:00 must be **atomic**: if destination is full/cancelled/closed, retain the original booking.
- Repeated or retried requests should not duplicate bookings or notifications. Use appropriate unique constraints and idempotency strategies.
- Coach cancellation racing with member booking must not leave an active booking in a cancelled slot.
- Admin schedule edits should not unexpectedly resurrect cancelled bookings.
- Server-derived status is authoritative; frontend clocks only improve UX.

## 3. Member registration and authentication (CONFIRMED)

### Member account

- Public registration, **no invite code, gym code, coach approval, email, phone, SMS or OAuth**.
- First registration: enter **display name** and choose a **six-digit numeric PIN**.
- Generate a unique member ID, e.g. `GYM-48291`, and a **strong one-time recovery code**; show recovery code once with instructions to store it safely.
- Returning on the same device: persistent secure session, no PIN entry on each visit.
- New device: sign in with **member ID + PIN**.
- Forgotten PIN: recover using **member ID + recovery code**, set new PIN, invalidate/rotate recovery code and existing sessions as appropriate. The recovery code is single-use; show replacement once.
- A six-digit PIN is low entropy. **Hash** PIN and recovery code with a password-hashing KDF (Argon2id recommended), use rate limits/lockouts and generic errors, never store or log plaintext secrets.
- Member ID is an identifier, not a secret. Ensure sufficient ID space, uniqueness and collision retry. Protect registration/recovery endpoints from abuse.

### Admin account

- Exactly **one admin** for MVP.
- Separate admin login route `/admin/login` using **username + strong password**, not member PIN.
- No public admin sign-up. Provision first admin securely via environment-driven one-time setup/CLI seed, with credentials not committed to source control. Rotate bootstrap credentials as needed.
- Server-enforced role/guard separation; admin API cannot be accessed using a member session.

### Sessions and web security (PROPOSED IMPLEMENTATION)

- Prefer server-managed sessions in secure, `HttpOnly`, `SameSite` cookies with appropriate `Secure` flags, session rotation, logout/revocation and expiry. Avoid localStorage auth tokens.
- If web and API are on different domains, design cookie/CORS/CSRF deliberately; a same-origin `/api` proxy is a reasonable option.
- CSRF defense for cookie-authenticated mutations, strict input validation, request size limits, origin allowlist, HTTPS, secure headers, least-privilege database credentials.
- Do not leak other members' names through member API payloads, logs, errors or demo data.
- No claim of verified real-world identity: possession of member ID + PIN is sufficient under this deliberately simple product model.

## 4. Member-facing PWA UX (CONFIRMED)

- **No calendar UI.** One simple mobile-first main screen for nearest scheduled training day.
- Show day/date, motivational announcement, cards for **19:00** and **20:00**, and each slot's occupancy `N/8` (or seats left). Never show other members' names.
- On a training date **before 14:00**, show both slots with disabled booking buttons and “Запис відкриється о 14:00”. If a slot is cancelled, show cancelled status instead.
- At 14:00, booking controls activate **without requiring a page reload**, subject to server authorization.
- On a day without training, show the **next scheduled training day**, fixed slots and when booking opens, considering admin exceptions.
- On a day with no upcoming scheduled date within the lookup horizon, show a helpful empty state rather than inventing a session.
- Before 21:00, member can book, cancel or switch their own slot; after 21:00 all booking controls are locked.
- When a slot reaches **8/8**, replace booking action with **“Сповістити про вільне місце”** where applicable. Members can unsubscribe.
- Show clear success/failure messages **in the UI** for member-initiated booking/cancellation/switch; no push for those actions.
- Occupancy updates automatically across open clients without reload. **Polling** is sufficient for MVP (e.g. 10–20 seconds, visibility-aware, plus immediate refresh after mutation). No WebSocket requirement. Polling frequency is a technical choice, not a guarantee of instantaneous delivery.
- Mobile-first, accessible tap targets, loading/empty/error/offline states, Ukrainian UI. Installable PWA with manifest and service worker.

## 5. Coach/admin UX (CONFIRMED)

- Separate protected admin area with today's/next training day and two fixed slots.
- Show `N/8`, participant **names** per slot and informational notice when below 3 members.
- Manage schedule exceptions: cancel a default training date, add an exceptional date, cancel/enable individual slots. Do not allow editing 19:00/20:00 time values.
- Cancel a slot/day with a confirmation step that explains existing bookings will be cancelled and affected members notified.
- **Do not** add/remove individual members' bookings manually.
- **Attendance:** coach can confirm attendance **at any time**, including during a session. One-click “Підтвердити всіх” or mark individual members present/absent. No automatic 21:00 approval queue, mandatory pending-review workflow or QR check-in. Attendance changes persist in DB. Avoid coupling attendance confirmation to booking lock.
- **AI announcements:** manage example texts (add/edit/delete), optional training topic, generate/regenerate, edit, approve and publish announcement. Can update topic/text after 14:00; changes appear in app **without sending a second opening push**.

### Attendance implementation detail (PROPOSED IMPLEMENTATION)

Store attendance per booking (e.g. `UNMARKED | PRESENT | ABSENT`), with `marked_at`/`marked_by`. “Confirm all” marks current active bookings as present; individual corrections are allowed. Do not require a separate approval lifecycle. Consider how late bookings after attendance confirmation are displayed (default `UNMARKED`) without resetting earlier marks.

## 6. Push notifications (CONFIRMED)

Only three event families:

1. **Booking opens** at 14:00 on an enabled training date. Send one opening push to subscribed, permitted members.
2. **Coach cancels slot/day.** Send push to members whose active bookings were cancelled.
3. **Seat becomes available in previously full slot.** Notify only members explicitly subscribed to that slot's vacancy alert, if still before 21:00. **First successful booking wins**; notification is not a reservation or waitlist. Unsubscribe supported.

Do **not** send push for a member's own booking, cancellation or slot switch; show UI confirmation. Do **not** resend opening push when coach edits announcement after 14:00.

### Delivery and platform constraints

- Use Web Push with VAPID keys, service worker and persisted browser push subscriptions. Handle expired subscriptions (e.g. 404/410) and user permission changes.
- On iOS, web push requires the supported installed Home Screen web app experience and explicit permission. Delivery is best-effort, not guaranteed.
- **Critical scheduling nuance:** Vercel Hobby Cron is not a precise-to-the-minute scheduler. The business rule “booking opens at 14:00” must be **computed by the API from time**, not dependent on a cron execution. An opening push scheduled via Hobby Cron may arrive late; do not promise exact 14:00 push delivery. Before real rollout, choose a scheduler/provider with appropriate precision/reliability if punctual delivery is required.
- Notifications must be **idempotent**, queued/outboxed where appropriate, and should not block a successful booking or admin cancellation.
- Protect push endpoint subscriptions against spoofing; each subscription belongs to the authenticated account/device. Do not disclose other users in payloads.
- Vacancy alert subscriptions should be scoped to **a particular slot occurrence** (date + 19:00/20:00), and expire/clean up after 21:00 or cancellation.
- Avoid notifying the member who just vacated a slot about their own cancellation; handle slot-switch notifications carefully.

## 7. AI-generated motivational announcements (CONFIRMED)

### Functional behavior

- Use a **free-tier cloud AI API** rather than local Ollama. Initial choice: **Google Gemini API** with a low-cost/free-tier text model (previously considered `gemini-2.5-flash-lite`; verify model availability, pricing, quotas and terms at implementation time). Do not assume perpetual free access.
- Coach manages **style examples in the admin panel**, stored in PostgreSQL; can add, edit and delete them without redeploy.
- Coach can optionally specify a topic (`ноги`, `спина`, `функціональне` etc.). If absent, generate a general invitation.
- Generate short, friendly, natural Ukrainian announcements in the coach's style, e.g. “Дівчатка, записуємось на тренування ніг сьогодні! 💪🍑”. Do not fabricate workout details if no topic was provided.
- Coach may generate/regenerate, edit and approve a text ahead of time.
- **Hybrid publication rule (latest decision supersedes earlier approval-only rule):**
  - If a coach-approved announcement exists for the date, publish/use **that** at opening time.
  - Otherwise, at/around 14:00, automatically generate and publish an AI text **without requiring approval**.
  - If generation fails, times out, quota is exhausted, or output is invalid, use a **safe deterministic standard announcement**.
- Opening of booking at 14:00 **must not wait for or depend on AI**. If scheduled generation runs late, show the fallback until AI content becomes available; do not send duplicate opening push.
- Coach can change topic and text after 14:00; update app display without a second push.
- AI never receives client IDs, names, PINs, recovery codes or participant lists.

### LLMOps baseline (MVP, practical not ornamental)

- Isolate provider behind `AnnouncementGenerator` interface and a NestJS `AiModule`; allow provider/model configuration by environment.
- Version prompts and record generation metadata: prompt version, provider, model, latency, token usage if available, success/failure, fallback reason, timestamp, whether coach edited/approved. Avoid logging sensitive data or secrets.
- Use structured output validation (Zod or class-validator), length and tone constraints, timeout, limited retries with backoff, and fallback.
- Protect against prompt injection from admin-supplied examples/topic; treat them as content, not system instructions. The only AI result used is announcement text; no tool access, database actions or privileged commands.
- Add a small offline evaluation fixture with sample topics/examples; check Ukrainian language, length, prohibited personal data, absence of fabricated booking facts, and reasonable style consistency. Do not require exact-string matches for generative text.
- For a portfolio demo, allow deterministic mocked AI generation without using paid quota or real push.
- Free-tier terms may permit provider data use for product improvement; do not submit personal/sensitive data. Reassess privacy/terms before real gym launch.

## 8. Recommended architecture and repository (PROPOSED IMPLEMENTATION)

### Stack

- Frontend: **Next.js**, React, TypeScript, mobile-first PWA.
- Backend: **NestJS** (required), TypeScript. Do not replace with Next.js route handlers as the primary business backend.
- ORM/migrations: **Drizzle ORM**.
- Database: **Neon PostgreSQL**, provisioned through Vercel Marketplace where appropriate.
- Hosting: **Vercel** for frontend and (if deployment feasibility is confirmed) NestJS API via a supported serverless adapter/deployment strategy.
- AI: **Google Gemini API Free Tier** subject to current quota/terms; no Ollama dependency in deployed MVP.
- Push: standards-based **Web Push / VAPID**.
- Package manager: `pnpm` workspaces; monorepo with shared TS configuration, ESLint, Prettier.
- Validation: NestJS DTOs + `class-validator` or Zod; choose one consistent strategy for shared contracts.
- Tests: Vitest/Jest as appropriate, Supertest API integration tests, Playwright browser e2e.

### Proposed directory structure

```text
GymFlow/
├── apps/
│   ├── web/                  # Next.js PWA, member and admin UIs
│   └── api/                  # NestJS modules/controllers/services/guards
├── packages/
│   ├── database/             # Drizzle schema, migrations, seed/demo fixtures
│   └── shared/               # DTOs/types/constants/validation contracts
├── docs/                     # ADRs, architecture diagrams, runbooks
├── scripts/                  # Admin bootstrap, demo seed/reset
├── .github/workflows/        # CI checks
├── .env.example
├── pnpm-workspace.yaml
└── PROJECT_SPEC.md
```

Suggested NestJS modules: `AuthModule`, `MembersModule`, `ScheduleModule`, `BookingsModule`, `AttendanceModule`, `NotificationsModule`, `AiModule`, `AdminModule`, `DemoModule` (demo-only entry points gated). Avoid building separate microservices.

### Vercel deployment feasibility gate

**Do not assume a traditional long-running NestJS server or worker runs unchanged on Vercel.** Before implementation, verify current Vercel runtime support, adapter, request handling, function timeouts, deployment topology, DB connection strategy, background job scheduling, and build process. If NestJS cannot meet runtime needs within the chosen tier, preserve NestJS and document an alternative host for the API; do not silently change the backend framework. Use Neon serverless-compatible connection pooling/driver as appropriate. No in-memory singleton state as a source of truth across function instances.

## 9. Database design (PROPOSED IMPLEMENTATION)

Use UUID primary keys internally, UTC timestamps, constraints, indexes and migrations. Distinguish `gym_local_date` (DATE, Europe/Kyiv) from event timestamps. Keep personal data minimal.

| Table | Key columns | Purpose |
|---|---|---|
| `members` | `id`, `member_code` UNIQUE, `display_name`, `pin_hash`, `recovery_hash`, `created_at`, `disabled_at` | Member identity and recovery |
| `admins` | `id`, `username` UNIQUE, `password_hash`, `created_at` | Single coach account |
| `sessions` | `id`, `principal_type`, `principal_id`, `token_hash`, `expires_at`, `revoked_at`, `created_at` | Revocable cookie sessions; member/admin separated |
| `training_days` | `id`, `local_date` UNIQUE, `status`, `is_exception`, `booking_open_override_at` NULL, timestamps | Materialized training dates/overrides; document generation horizon |
| `training_slots` | `id`, `training_day_id`, `slot_time` (`19:00`/`20:00`), `status`, `capacity` DEFAULT 8, `cancelled_at` | Slot occurrence and capacity; UNIQUE(day,time) |
| `bookings` | `id`, `member_id`, `training_day_id`, `slot_id`, `status`, `created_at`, `cancelled_at` | Active/cancelled booking history |
| `attendance` | `booking_id` UNIQUE, `status`, `marked_at`, `marked_by_admin_id` | Attendance confirmation, no separate approval queue |
| `push_subscriptions` | `id`, `member_id`, `endpoint` UNIQUE, `p256dh`, `auth`, `created_at`, `disabled_at` | Web Push subscriptions (protect stored keys) |
| `vacancy_alerts` | `id`, `member_id`, `slot_id`, `active`, `created_at` | Opt-in free-seat alerts; UNIQUE(member,slot) |
| `notification_events` | `id`, `event_type`, `dedupe_key` UNIQUE, `payload`, `status`, `attempts`, `created_at`, `sent_at` | Durable outbox and idempotency |
| `announcement_examples` | `id`, `text`, `created_at`, `updated_at` | Coach-provided style examples |
| `announcements` | `id`, `training_day_id` UNIQUE, `topic`, `text`, `source`, `approved_at`, `published_at`, `updated_at` | Today's generated/edited/published text |
| `ai_generations` | `id`, `announcement_id`, `provider`, `model`, `prompt_version`, `latency_ms`, `token_usage`, `status`, `fallback_reason`, `created_at` | Minimal LLMOps audit |

**Key constraints:**

- At most one active booking per member per local date: partial unique index on `(member_id, training_day_id)` where `status = 'ACTIVE'`.
- Booking references must agree on `training_day_id` and `slot_id` (enforce by FK/composite FK or transaction validation, preferably DB constraint).
- Only two slot times, UNIQUE(training_day_id, slot_time).
- Capacity 8 enforced under **row-level locking/serializable transaction or equivalent atomic SQL**, **not** by a simple count-then-insert without locking. Partial unique index alone does not enforce per-slot capacity.
- Consider a `booked_count` column on `training_slots` updated atomically under row lock for efficient concurrency; verify consistency with active bookings, including cancellations and switches. If using count queries instead, explicitly serialize slot mutations. Document chosen approach and tests.
- Cancelled bookings retained for audit; active uniqueness allows later rebooking, but no double active booking.
- Avoid persisting default M/W/F indefinitely: materialize a rolling horizon or derive default dates plus overrides; ensure jobs are idempotent and an exception is not lost when regenerating dates.
- All demo data must be isolated from production, ideally separate Neon branch/database and environment, not a `demo=true` bypass on production tables.

### Transaction scenarios

**Book:** authenticate member → validate date/time/slot → transaction lock target slot (and per-member/day serialization) → ensure no active booking that day and `booked_count < 8` → insert active booking + increment count → commit → return authoritative state.

**Cancel own booking:** authenticate → validate before 21:00 → transaction lock slot and booking → mark cancelled + decrement count → if transition **8→7**, enqueue vacancy event for active subscribers, excluding actor → commit.

**Switch:** authenticate → validate target → transaction lock relevant slots in stable ID order and member/day → verify capacity/status → cancel old + decrement old; insert new + increment target atomically → enqueue vacancy event only for a formerly full origin slot → commit. If any check fails, rollback all.

**Cancel slot:** admin auth → transaction lock slot → mark cancelled → cancel all active bookings, update count to zero → enqueue targeted cancellation notifications with dedupe keys → commit. Send pushes asynchronously/outside transaction.

**Attendance:** admin marks individual bookings or all current active bookings; don't make attendance changes affect capacity or booking eligibility.

## 10. API contract outline (PROPOSED IMPLEMENTATION)

Version prefix `/api/v1`; document all endpoints with OpenAPI/Swagger and consistent typed responses. Names may be adjusted for REST consistency, but behavior must stay intact.

### Member auth

| Method | Endpoint | Behavior |
|---|---|---|
| `POST` | `/auth/member/register` | Name + 6-digit PIN; returns member code and one-time recovery code |
| `POST` | `/auth/member/login` | Member code + PIN; sets session cookie |
| `POST` | `/auth/member/recover` | Member code + recovery code + new PIN; rotates recovery code/sessions |
| `POST` | `/auth/logout` | Revoke current session |
| `GET` | `/auth/me` | Role, own profile, authenticated status |

### Admin auth

| Method | Endpoint | Behavior |
|---|---|---|
| `POST` | `/auth/admin/login` | Username + password; sets admin session cookie |
| `POST` | `/auth/admin/logout` | Revoke admin session |

### Member booking and display

| Method | Endpoint | Behavior |
|---|---|---|
| `GET` | `/schedule/next` | Nearest relevant date, slot statuses/counts, opening/closing instants, announcement, own booking status; **no participant names** |
| `POST` | `/bookings` | Book slot; transactional constraints |
| `DELETE` | `/bookings/current` | Cancel own active booking before lock |
| `PATCH` | `/bookings/current` | Atomically switch slot before lock |
| `PUT` | `/slots/:slotId/vacancy-alert` | Subscribe to free-seat push for a full slot |
| `DELETE` | `/slots/:slotId/vacancy-alert` | Unsubscribe |
| `POST` | `/push/subscriptions` | Register own browser subscription |
| `DELETE` | `/push/subscriptions` | Remove own browser subscription |

### Admin operations

| Method | Endpoint | Behavior |
|---|---|---|
| `GET` | `/admin/schedule` | Schedule exceptions, group occupancy and participant names |
| `PUT` | `/admin/training-days/:date` | Add/cancel date or change exception; strict DTO |
| `PATCH` | `/admin/slots/:slotId` | Enable/cancel fixed slot; enforce cancellation semantics |
| `GET` | `/admin/slots/:slotId/participants` | Names + attendance statuses, admin only |
| `PUT` | `/admin/slots/:slotId/attendance/all` | Mark current active bookings present |
| `PATCH` | `/admin/bookings/:bookingId/attendance` | Mark present/absent |
| `GET/POST/PATCH/DELETE` | `/admin/announcement-examples` | CRUD examples |
| `PUT` | `/admin/announcements/:date/topic` | Set optional topic |
| `POST` | `/admin/announcements/:date/generate` | Generate/regenerate text |
| `PUT` | `/admin/announcements/:date` | Edit/approve/publish text |

### Internal automation

- Secure internal endpoint(s) for schedule materialization, announcement generation, opening notification dispatch and outbox delivery. Authenticate with a separate secret or platform identity; never expose admin cron functionality publicly.
- Keep jobs idempotent with stable event keys like `booking-open:<local-date>` and `cancel:<slot-id>:<revision>`.
- Generate opening push only for valid enabled training dates and respect timezone and cancellations. Distinguish **booking eligibility at 14:00** from **job execution time**.

### Response/error standards

Use `401` unauthenticated, `403` wrong role, `404` unknown/hidden resource, `409` full slot/conflict/already booked, `422` invalid business action (or documented `400` convention), `429` auth abuse, `5xx` internal. Do not return private participant data to members. Avoid logging PINs, recovery codes, credentials, push auth secrets or raw AI API keys.

## 11. Demo Mode (CONFIRMED)

Provide a **separate, safe portfolio demo** that works in minutes without waiting for real local time or spending AI quota.

- Seed fake admin and member accounts, slots, sample topics/examples, and realistic 0/8, 7/8, 8/8 scenarios.
- Support simulated clock/scenario controls **only in demo/test environment** to demonstrate pre-14:00, open, post-21:00, cancellations, slot switching, vacancy alert and attendance confirmation.
- Mock push delivery visibly (e.g. demo event log) when browser permission is unavailable; don't promise actual push in every browser.
- Mock AI deterministically as an option; separately demonstrate real Gemini integration when configured.
- **Never** expose time-travel, fake authorization, admin bootstrap or seed/reset endpoints in production. Prefer separate Neon branch, deployment/environment and explicit build-time/environment gating. Fail closed.
- Demo credentials may be displayed for the isolated demo only; they must not grant production access.

## 12. Testing and acceptance criteria

### Automated test pyramid

- Unit: date/time/DST calculations, schedule exception precedence, slot status, booking window, capacity checks, notification eligibility, announcement fallback, DTO validation.
- Integration against PostgreSQL (not an in-memory DB substitute for concurrency): Drizzle migrations, unique indexes, rollback, row locking, 8/8 racing bookings, same member booking two slots concurrently, atomic switch and cancellation races.
- API auth/security: member vs admin separation, protected counts, admin-only participant names, brute-force throttling, recovery rotation, invalid PIN, CSRF/cookie behavior, malformed payloads.
- E2E browser: register → recovery-code screen → login → book → switch → cancel; full-slot alert subscription; admin cancel and attendance; pre-14:00 and post-21:00 demo time; PWA install basics.
- AI: mocked model responses, timeouts, malformed text, exhausted quota, prompt injection examples, approved-vs-auto-vs-fallback selection, no duplicate push on edits.
- Push: subscription lifecycle, expired endpoint cleanup, dedupe, cancellation recipients, 8→7 alerts, no alerts after 21:00.

### MVP acceptance checklist

- [ ] Public member registration returns unique member code and one-time recovery code; PIN never stored plaintext.
- [ ] Member ID + PIN login works on another device; recovery code can reset PIN once and rotates.
- [ ] Admin uses separate username/password login and is not publicly registrable.
- [ ] Anonymous visitors cannot access schedule/counts; members cannot access names or admin endpoints.
- [ ] Default M/W/F schedule, exceptions, fixed 19:00/20:00 slots work in Kyiv timezone.
- [ ] Before 14:00, disabled buttons; at 14:00 API allows booking without relying on cron; at 21:00 both slots lock.
- [ ] Max 8 per slot and one active booking per member/date hold under concurrent requests.
- [ ] Member can cancel or atomically switch; failed switch preserves original booking.
- [ ] Under-3 occupancy never triggers automatic cancellation.
- [ ] Coach can cancel slot/day; active bookings cancelled, no auto-transfer, appropriate push event queued.
- [ ] Member sees only occupancy, own state and announcement; admin sees names.
- [ ] Counts update automatically without manual page reload.
- [ ] Vacancy push opt-in/out and 8→7 event; no auto-booking/waitlist.
- [ ] Coach marks attendance anytime, individually or all at once.
- [ ] Coach CRUDs AI style examples and optional topic; can edit/approve/regenerate text.
- [ ] Approved text wins; otherwise automatic AI; safe fallback on failure; no AI dependency for booking opening.
- [ ] No push for own booking actions or post-14:00 text edits.
- [ ] Isolated demo shows all core scenarios without production bypasses.
- [ ] Lint, typecheck, migrations, core tests and deployment smoke checks pass.

## 13. Implementation phases and handoff gates

Do **not** implement all phases in one shot. Each phase must end with commands run, observed results, limitations and a request for review.

**Phase 0 — Feasibility and design:** verify current Vercel NestJS support, free-tier Gemini terms, Neon connection strategy, push/scheduler limitations; choose deployment topology; architecture decision records and `.env.example`. No business logic yet.

**Phase 1 — Monorepo and foundations:** scaffold `apps/web`, `apps/api`, `packages/database`, `packages/shared`; TS/lint/test/CI; Neon connection; Drizzle migrations; health endpoint; configuration validation.

**Phase 2 — Authentication and security:** member registration/login/recovery/session; separate admin login and secure bootstrap; guards, rate limiting, privacy tests.

**Phase 3 — Schedule and booking engine:** default days + exceptions, slots, authoritative time windows, concurrency-safe booking/cancel/switch, counts, API tests. This is the highest-risk phase: prove transaction safety before building extra UI.

**Phase 4 — Client PWA:** mobile-first nearest-training screen, pre-open/closed states, booking actions, polling, installability, offline/error UX.

**Phase 5 — Admin and attendance:** participant lists, day/slot cancellation, exceptions, attendance actions, security tests.

**Phase 6 — Push:** VAPID, subscriptions, event outbox, cancellation alerts, vacancy alerts, opening alerts, cron/scheduler strategy and graceful delivery degradation.

**Phase 7 — AI and LLMOps:** Gemini provider, examples CRUD, optional topic, hybrid approved/automatic publication, safe fallback, generation telemetry, offline evals.

**Phase 8 — Isolated demo and portfolio polish:** demo fixtures/clock, scenario selector, seeded fake accounts, README, architecture diagram, screenshots, test report and production-readiness checklist.

**Phase 9 — Deployment and verification:** staging/portfolio deploy, environment configuration, DB migrations, end-to-end smoke tests, basic monitoring, documented limitations. Do not equate a successful build with a validated deployment.

### Required handoff after each phase

1. Brief summary of implemented functionality and why.
2. File list and noteworthy decisions.
3. Exact commands run, tests passed/failed, outstanding risks.
4. How to reproduce locally.
5. Next phase proposal, **await approval**.

## 14. Post-MVP TODO — do not build now

- Client-facing **training history** and attendance statistics; trainer analytics/history dashboards. Store attendance records now so this can be added later.
- Multiple administrators, role delegation and audit dashboards.
- Attendance QR/check-in or advanced attendance analytics (only if later requested).
- **AI Engineering roadmap (Sections 17–23):** read-only trainer assistant with controlled tool calling, RAG over approved gym documents, optional MCP server, evaluation and tracing. **Post-MVP only; explicit approval required for each phase.** Do not introduce agentic actions into booking MVP.
- Calendar UI, payments/subscriptions, SMS/email/social login, waitlist, automatic seat reservation, manual coach booking management — **not requested for MVP** and should not be treated as implicitly approved roadmap items.

## 15. Open engineering details to document, not silently invent

- Exact deployment topology for NestJS on Vercel vs alternative host; verify at implementation time.
- Scheduler reliability for 14:00 **push** (distinct from deterministic 14:00 booking access); best-effort for portfolio, reassess before real gym.
- Admin manual opening override semantics (date, affected slot(s), duration, permissions) if included in MVP. Preserve regular 14:00/21:00 rules by default.
- Whether an added exceptional training date can be created after 14:00; if so, opening behavior and push dedupe.
- Behavior if trainer cancels and later re-enables a slot/day: never silently restore old bookings; define a clean re-open action.
- Attendance edits while late bookings are still permitted (until 21:00): default new booking to unmarked.
- Rate limits, session TTL, push polling interval, demo clock implementation, provider model identifier, environment naming and notification retry policy — choose safe defaults and document.
- Default AI text and notification wording; keep concise, Ukrainian and free of private member details.

## 16. Real-gym launch readiness (not required for portfolio demo)

Before onboarding real clients: confirm hosting commercial-use terms (including Vercel Hobby restrictions), actual uptime/cost, scheduler precision, Web Push behavior on target devices, security review, DB backups/restore, logging/alerts, data retention/privacy notice, recovery support, load/concurrency testing and operational incident procedures. A portfolio demo is not automatically production-ready.

---

## 17. Post-MVP AI Engineering scope and non-goals (PROPOSED ROADMAP, NOT MVP)

This roadmap is intentionally concrete for a portfolio AI Engineering / LLMOps showcase, but **none of its phases is authorized for implementation by this specification alone**. The user confirmed only the announcement-generation AI for MVP. The following agent/RAG/MCP ideas are **proposals**, to be validated against real needs and approved separately.

### Proposed use cases

1. **Read-only trainer assistant:** coach asks in Ukrainian, “Скільки людей записано сьогодні на 19:00?”; assistant calls a strictly scoped availability tool, then explains the result.
2. **Attendance summary:** coach asks, “Скільки людей фактично було на тренуваннях цього тижня?”; assistant calls a read-only attendance aggregation tool. This is not a replacement for manual attendance confirmation.
3. **Document-grounded gym FAQ (RAG):** coach uploads gym policies, training descriptions and FAQ; assistant answers questions using retrieved source passages and cites the underlying document.
4. **MCP integration showcase:** expose a small read-only GymFlow tool catalog to explicitly authorized MCP clients. Do not expose a public unauthenticated MCP endpoint.

**Non-goals:** autonomous booking/cancellation, changing schedule, approving attendance, sending pushes, reading PINs/recovery codes, exposing participant names to ordinary members, making health/training prescriptions, or inventing policies. Do not add a multi-agent framework merely for portfolio buzzwords. Start with a single assistant that calls deterministic tools.

### Boundary: MVP versus later AI

| Capability | MVP | Post-MVP |
|---|---|---|
| Announcement generation and coach examples | Yes | Improve if useful |
| Prompt versioning, output validation, fallback, basic logs/evals | Yes | Expand |
| Conversational trainer assistant | No | Proposed Phase A1 |
| Read-only structured tool calling | No | Proposed Phase A1 |
| Document upload/ingestion and RAG | No | Proposed Phase A2 |
| Embeddings and vector search | No | Proposed Phase A2 |
| MCP server/client integration | No | Proposed Phase A3 |
| Distributed traces, eval regression dashboard, cost/quality analysis | Basic metadata only | Proposed Phase A4 |
| Agent write actions | No | Out of scope unless explicitly approved later |

## 18. AI architecture and trust boundaries (POST-MVP PROPOSAL)

Keep one NestJS deployment; extend the existing `AiModule` with separately testable services. Do not bypass existing NestJS guards or domain services.

```text
Admin UI (authenticated coach)
    -> NestJS AI Assistant Controller
       -> AuthGuard / role guard / request limits
       -> Assistant Orchestrator (bounded steps, structured responses)
          -> LLM Provider Adapter (Gemini initially)
          -> Tool Registry (allowlisted, read-only)
             -> Schedule Query Service
             -> Attendance Aggregation Service
          -> Retrieval Service (optional, after A2)
             -> Document permissions + hybrid/vector search
       -> AI Telemetry / Evaluations / Audit
```

- Use an `LlmProvider` abstraction and separate interfaces for `generateText`, `generateStructured`, `embedText` (optional), and tool calling, since free-tier model capabilities and limits can change. **Verify provider support and quotas in Phase A0**; do not assume every model offers embeddings or reliable function calling.
- Keep deterministic booking, capacity, authorization, attendance marking and notifications in existing services. Model output is **never** treated as an authorization decision.
- No arbitrary SQL, raw database credentials, dynamic code execution, filesystem/network browsing or user-defined tool endpoints exposed to the model.
- Treat user prompts, tool responses and retrieved documents as untrusted data. Tool output may contain adversarial instructions; serialize it as data and maintain the system/tool boundary.
- Enforce server-side user identity and role for **each tool execution**, not only for the assistant HTTP endpoint. The model cannot elevate scope by requesting an admin-only tool.
- Cap steps/tool calls, response size, retrieval volume, timeouts, and token budgets; return a clear error or non-AI fallback rather than looping.
- Avoid recording sensitive inputs, member identities or full tool payloads in telemetry. Apply retention, redaction and environment separation.
- Only the authenticated **admin** can use the proposed trainer assistant in the first iteration. A member-facing assistant requires a separate privacy/product decision.

## 19. Agent + tool calling: proposed Phase A1

### Tool contracts

Tool schemas are **typed, versioned, allowlisted and read-only**. The model supplies only validated business arguments, never principal IDs or role claims. The server supplies authorization context.

| Tool | Example input | Example output | Access |
|---|---|---|---|
| `get_training_schedule` | `{ "date": "2026-10-19" }` | date, slot times/status, open/close instants | Admin |
| `get_slot_availability` | `{ "date": "2026-10-19", "time": "19:00" }` | capacity, booked count, remaining count | Admin |
| `get_attendance_summary` | `{ "from": "2026-10-01", "to": "2026-10-16" }` | counts of present/absent/unmarked | Admin |
| `get_training_topic` | `{ "date": "2026-10-19" }` | optional topic and announcement status | Admin |

For all tools: ISO dates validated; date ranges bounded; slot time is an enum; no raw participant names, member IDs or secret data in tool results. Return explicit `NOT_FOUND`, `FORBIDDEN`, `INVALID_ARGUMENT`, `TEMPORARILY_UNAVAILABLE` errors; do not fabricate missing data. Attendance aggregates must distinguish **unmarked** from **absent**, and booking counts from actual attendance.

### Agent execution

1. Validate authenticated admin session, user input, input size and rate limit.
2. Load a versioned assistant system prompt and only the allowlisted tool definitions.
3. Request structured tool calls from provider, validate arguments using shared DTO/Zod schemas.
4. Execute tool through a dedicated application service with server-side auth; record sanitized tool name, latency and status.
5. Return tool results as data to model, permit at most a small configured number of tool rounds (e.g. 3), then validate the final Ukrainian answer.
6. If provider fails, return a clear error and, when possible, offer the deterministic dashboard data already available through the normal UI.

**Acceptance scenarios:** correct 19:00 availability, no training on cancelled day, attendance pending vs absent, invalid date, model hallucination challenge, forbidden tool, malformed arguments, timeout, repeated calls, prompt injection inside tool response. Use mock model tests plus a small opt-in live smoke test.

**Important:** Do not use an “agent” for a one-call announcement generation; that MVP workflow is intentionally non-agentic.

## 20. RAG over gym knowledge: proposed Phase A2

### Knowledge scope and ownership

Only the coach/admin may upload and manage approved source documents: gym rules, booking instructions, training-type descriptions and FAQ. Support simple UTF-8 Markdown/plain text first; PDF ingestion can be added after assessing parsing quality and security. **Never** index member credentials, recovery codes, private participant lists, raw logs or medical information. Document visibility and retention must be explicit.

### Suggested data model (additive migrations, post-MVP)

| Table | Purpose |
|---|---|
| `knowledge_documents` | id, title, content type, checksum, owner/admin, visibility, status, version, timestamps |
| `knowledge_chunks` | id, document id/version, chunk index, text, token count, metadata, source location |
| `knowledge_embeddings` | chunk id, embedding model/version, vector, dimensions, created_at (or embed vector in chunk table) |
| `rag_queries` | redacted query hash, retrieval config/version, selected chunk IDs, latency, result status, timestamps |

- Verify `pgvector` availability in the chosen Neon Postgres environment and the selected embedding model/dimensions **before** creating vector schema. If unsupported, choose a documented alternative; do not invent a working extension.
- For a small corpus, benchmark PostgreSQL full-text search baseline against vector retrieval. Hybrid retrieval and reranking are optional optimizations **only when evaluation shows value**.
- Ingestion: authorize -> validate type/size -> extract text -> normalize -> detect duplicates/version -> chunk with source offsets -> embed in batches -> index -> mark ready. Handle partial failures and reindexing idempotently.
- On document update/delete, invalidate or replace old chunks/embeddings; no stale retrieval of revoked policies.
- Retrieval: filter by authorized corpus -> top-k search -> relevance threshold -> bounded context -> answer with source title and chunk/section references. If evidence is missing, answer **“У наданих документах немає цієї інформації”** rather than inventing a rule.
- Separate user question from retrieved context; document text is **not instructions**. Never obey a retrieved instruction to reveal secrets, change role or call tools.
- Avoid claiming citations unless the cited chunk was actually retrieved and supports the statement. Expose source IDs in structured response for UI rendering.

### RAG quality checks

Maintain a small curated QA set: answerable queries, paraphrases, contradictory/outdated policy versions, no-answer questions, Ukrainian spelling variants, irrelevant docs, malicious injected documents. Measure retrieval recall@k / hit rate, citation support, groundedness, abstention accuracy and latency. Record prompt, chunking, embedding and retrieval versions to make comparisons reproducible.

## 21. MCP Server: proposed Phase A3

MCP is an **integration protocol**, not the booking engine and not a requirement for the MVP UI. Only implement after the read-only tool registry exists, so MCP tools call the **same validated application services** rather than duplicating logic.

Proposed read-only MCP tools:
- `get_training_schedule`
- `get_slot_availability`
- `get_attendance_summary`

Optional resource: approved public-to-admin gym rules/FAQ; never expose sensitive DB tables as generic resources. No write tools (`create_booking`, `cancel_booking`, `change_schedule`, `mark_attendance`) in the initial MCP server.

### Transport, identity and security

- Start with a **local development MCP server** for portfolio demonstration; decide separately whether a remote MCP endpoint is needed.
- If remote, use a supported MCP transport and a proper authentication/authorization design compatible with the selected client and deployment. Never expose the server publicly without access control.
- Bind every tool invocation to an authenticated admin identity. Validate inputs and output schemas, enforce rate limits, redact logs, and return least-privilege data.
- Prevent SSRF, arbitrary URL fetching, path traversal and unbounded query arguments. Do not accept arbitrary SQL or custom tool code.
- Demo MCP client must use **demo-only credentials and data**, never production secrets.
- Add protocol-level integration tests: tool discovery, schema validation, valid/invalid calls, unauthorized calls, unavailable DB, no accidental write capability.

## 22. Advanced LLMOps and evaluation: proposed Phase A4

### Observability

Use OpenTelemetry-compatible spans if feasible for the deployment, or structured correlation IDs when full tracing infrastructure is excessive. Trace logical stages without logging raw secrets:

`http.request -> ai.orchestrator -> llm.generate -> tool.execute / rag.retrieve -> response.validate`

Capture per-run: anonymized request/correlation ID, provider/model, prompt version, tool/schema version, retrieval/embedding version (if relevant), latency per stage, token usage when available, estimated cost when provider pricing is known, retry/fallback reason, structured validation failures, tool errors and source IDs. Do not claim zero cost simply because a Free Tier exists; track usage against quotas and changing terms.

### Evaluations and CI

- **Announcements (MVP baseline -> expanded):** Ukrainian fluency, brevity, tone/style consistency, correct use of optional topic, no invented training facts, safe fallback, injection resistance.
- **Agent:** tool-selection correctness, argument validity, role compliance, factual answer consistency with tool data, bounded tool steps, no fabricated counts.
- **RAG:** retrieval hit rate/recall@k, citation precision/support, groundedness, correct abstention and stale-policy handling.
- **Security:** adversarial prompts from user input, tool output and retrieved documents; attempts to obtain credentials, cross-role data or trigger writes.
- **Reliability:** provider 429/5xx, timeouts, empty/malformed structured outputs, missing embeddings, empty corpus, database outages.
- Maintain versioned test fixtures, expected invariants and regression thresholds; run deterministic mocks in CI. Live-model evals are opt-in due to quota, cost and non-determinism. Store aggregate outcomes and manually review a small sampled set with privacy-safe data.
- Prefer a lightweight local report/JSON dashboard initially; add hosted tracing/eval products only if they bring measurable benefit and their privacy/pricing is acceptable.

### Suggested portfolio evidence

Architecture diagram with trust boundaries; screenshots of agent tool calls and RAG citations using fake data; evaluation matrix showing before/after a prompt or retrieval improvement; traces with redacted payloads; a short threat model; reproducible demo commands. **Never** present mocked results as real-model evaluation results.

## 23. AI roadmap phases, dependencies and approval gates (POST-MVP)

These are **additional phases after the existing MVP Phase 9**, not replacements for it. Each requires explicit user approval and the same test/report/review handoff contract as MVP phases.

| Phase | Deliverable | Gate to proceed |
|---|---|---|
| **A0 — AI feasibility/design** | Verify current Gemini tool-calling/embedding options, quotas, MCP SDK, Neon vector support; write ADRs and threat model | Approved design, no code |
| **A1 — Read-only coach agent** | Authenticated assistant UI/API, tool registry, bounded orchestration, mock/live tests | No privilege escalation, no write tools, accurate tool-grounded answers |
| **A2 — RAG** | Admin knowledge CRUD, ingestion, indexing, retrieval, grounded answer citations, eval dataset | Correct permissions, abstention, source attribution, reindex/delete |
| **A3 — MCP** | Local authenticated read-only MCP integration + test client | Tool parity, no writes, no sensitive data leaks |
| **A4 — Advanced LLMOps** | Traces, evaluation regression reports, quota/cost tracking, injection tests, portfolio artifacts | Reproducible results and privacy review |

### Scope discipline for Claude Code

- Implement **MVP Phases 0–9 first**. Do not create agent/RAG/MCP folders, DB tables, embeddings, dependencies or endpoints prematurely unless the owner explicitly approves the corresponding post-MVP phase.
- Preserve a clean `AiModule` interface in MVP so later phases are additive.
- For each future phase, propose exact files, migrations, endpoints, dependencies, resource/cost impact, tests and a rollback path **before writing code**.
- Favor simple, verifiable implementations over unnecessary agent frameworks, vector infrastructure or multi-agent orchestration.
- Do not assume Gemini Free Tier supports every capability indefinitely; validate model/tool/embedding availability at implementation time.
- Keep demo and production identities, knowledge bases, traces and credentials isolated.

---

**Final instruction to Claude Code:** Treat this file as the source of truth for agreed product behavior. Start with a feasibility/design review and wait for explicit permission to implement Phase 1. Preserve simplicity and do not add a calendar, payment system, manual coach booking controls, mandatory AI approval, or 21:00 attendance approval queue.
