const BASE = "/api";

type Ok = { ok: boolean };

// A JSON body goes with its Content-Type; a request without one sends neither
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.message ?? res.statusText), {
      status: res.status,
      body,
    });
  }
  // NestJS sends an empty body for a null result (e.g. a trainer with no upcoming trainings)
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T = Ok>(path: string, body?: unknown) => request<T>(path, "POST", body);
const put = <T = Ok>(path: string, body?: unknown) => request<T>(path, "PUT", body);
const patch = <T = Ok>(path: string, body?: unknown) => request<T>(path, "PATCH", body);
const del = <T = Ok>(path: string, body?: unknown) => request<T>(path, "DELETE", body);

// This browser's push subscription, if any. getRegistration(), not serviceWorker.ready: ready never
// resolves when no service worker is registered
async function currentPushEndpoint(): Promise<string | null> {
  try {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager?.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

export type TrainingType = "групові" | "персональні" | "спліт";

// Natural order for names: "Member 2" before "Member 10", Ukrainian alphabet (є, і, ї in place)
const nameCollator = new Intl.Collator("uk", { numeric: true, sensitivity: "base" });

export interface AdminMember {
  id: string;
  memberCode: string;
  displayName: string;
  trainerNote: string | null;
  trainerId: string | null; // null = not assigned (shown to every trainer under «Без тренера»)
  createdAt: string;
  recentCancellations: number; // member's own cancellations in the last 30 days (moves not counted)
  // The card the client has: active until `until`, or waiting for «Активувати» until `until` (then it burns)
  clubCard: { state: "waiting" | "active"; until: string } | null;
  packagesLeft: { trainingType: TrainingType; left: number }[]; // usable packages only, types with trainings left
  frozenUntil: string | null; // frozen today: the last frozen day
}

// A training the client was booked on (up to today) and the trainer's mark
export interface MemberVisit {
  bookingId: string;
  localDate: string;
  slotTime: string;
  trainingType: TrainingType;
  attendance: AttendanceStatus;
}

export interface Trainer {
  id: string;
  username: string;
  createdAt: string;
  invitedBy: string | null; // null = added by the seed script
  disabledAt: string | null; // null = works
  disabledBy: string | null;
}

// An invite link still waiting to be used (any trainer's)
export interface TrainerInvite {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

// Price list shared by all trainers (members see it without trainer names: PriceListItem); purchases copy its amounts
export type PriceSection = "club_card" | "assigned" | "group";

export interface PriceItem {
  id: string;
  section: PriceSection;
  title: string;
  optionLabel: string | null; // "3 місяці", "6 тренувань"; null for a single-option item
  amountUah: number;
  updatedBy: string | null; // trainer username; null = never changed since the seed
  updatedAt: string | null;
}

// A trainer's regular group trainings («Розклад групових»): times per weekday (1 = Пн … 7 = Нд), one opening time for
// booking on the training day, and whether they are created 3 weeks ahead by themselves
export interface TrainerSchedule {
  bookingOpensAt: string; // "HH:MM"
  autoCreate: boolean;
  times: { weekday: number; slotTime: string }[];
}

// A schedule training left out of the calendar on «Зберегти»: cancelled there, or the time is taken
export interface SkippedTraining {
  date: string; // "YYYY-MM-DD"
  slotTime: string;
  reason: "cancelled" | "taken";
}

// One option of the public price list (no trainer names)
export type PriceListItem = Omit<PriceItem, "updatedBy" | "updatedAt">;

export interface PriceChange {
  id: string;
  title: string;
  optionLabel: string | null;
  oldAmountUah: number;
  newAmountUah: number;
  changedBy: string;
  changedAt: string;
}

// ── Purchases: club cards, trainer packages and group passes ────────────────
// Nothing starts on payment: a card waits for the trainer's «Активувати з сьогодні», a package / group pass for its
// first mark. Not activated within a month of the purchase, it burns

export type PurchaseMethod = "LIQPAY" | "CASH";
export type AssignedType = Exclude<TrainingType, "групові">;

export interface LiqPayCheckout {
  data: string;
  signature: string;
}

export interface CatalogItem {
  id: string;
  title: string;
  optionLabel: string | null;
  amountUah: number;
  durationMonths: number | null; // months from activation (0 = that day only)
  trainingType: TrainingType | null; // trainer service or group pass
  trainingCount: number | null;
}

export type CardState = "waiting" | "active" | "expired" | "burned";
export type PassState = CardState | "used";

// The card a member has now (waiting or active); dates are YYYY-MM-DD
export interface ClubCard {
  id: string;
  label: string;
  state: "waiting" | "active";
  validUntil: string | null; // set once active
  activateBy: string; // last day to activate a waiting card
}

export interface TrainingPackage {
  id: string;
  trainingType: TrainingType;
  title: string;
  total: number;
  left: number;
  state: PassState;
  purchasedOn: string;
  activateBy: string;
  activatedOn: string | null;
  validUntil: string | null;
  createdAt: string;
}

export interface PurchaseLine {
  section?: PriceSection; // club_card → shown as «Клубна карта · …»
  title: string;
  optionLabel: string | null;
  amountUah: number;
}

export interface Purchase {
  id: string;
  method: PurchaseMethod;
  status: "PENDING" | "PAID" | "REJECTED" | "FAILED" | "EXPIRED" | "CANCELLED";
  totalUah: number;
  createdAt: string;
  lines: PurchaseLine[];
}

// Money that came after its purchase ended: nothing was given for it (trainer: «Гроші без покупки»)
export interface StrayPayment {
  paymentId: string;
  memberId: string;
  displayName: string;
  amountUah: number;
  liqpayPaymentId: string | null; // to find the payment for a refund
  paidAt: string;
  lines: PurchaseLine[];
}

export interface CashRequest extends Purchase {
  memberId: string;
  displayName: string;
}

export interface MemberPurchases {
  card: ClubCard | null;
  cards: {
    id: string;
    label: string;
    state: CardState;
    validFrom: string | null;
    validUntil: string | null;
    activateBy: string;
    source: "purchase" | "manual";
  }[];
  packages: TrainingPackage[];
  purchases: (Purchase & { decidedBy: string | null })[];
}

export interface MyPurchases {
  catalog: { clubCards: CatalogItem[]; services: CatalogItem[]; groupPasses: CatalogItem[] };
  card: ClubCard | null;
  // The latest card with its state: shows «згоріла» / «закінчилась» when there is no card any more
  lastCard: { label: string; state: CardState; activateBy: string; validUntil: string | null } | null;
  packages: TrainingPackage[];
  pending: Purchase | null;
  canPayCash: boolean; // cash goes to the member's trainer
}

// «Заморозити абонемент»: until = the last frozen day (null while the trainer hasn't approved)
export interface MyFreeze {
  freeze: {
    id: string;
    state: "requested" | "active" | "unfreeze_requested";
    startedOn: string | null;
    until: string | null;
  } | null;
  canFreeze: boolean; // a card or trainings to freeze, and no open freeze
}

// A freeze or unfreeze waiting for the trainer. until: the last frozen day (for a request: if approved today)
export interface FreezeRequest {
  id: string;
  memberId: string;
  displayName: string;
  kind: "freeze" | "unfreeze";
  requestedAt: string;
  startedOn: string | null;
  until: string;
}

export interface MemberFreeze {
  id: string;
  status: "REQUESTED" | "ACTIVE" | "ENDED" | "REJECTED" | "CANCELLED";
  requestedAt: string;
  startedOn: string | null;
  until: string | null; // the last frozen day
  unfreezeRequested: boolean;
  decidedBy: string | null;
}

// «Статистика»: paid purchases of the trainer's clients by the month they were paid; load = people marked ✓
export interface Revenue {
  clubCards: number;
  personal: number;
  split: number;
  group: number;
  total: number;
}

export interface TrainerStats {
  revenue: { allTime: Revenue; months: (Revenue & { month: string })[] }; // months: "2026-10", newest first
  busiestDays: { localDate: string; present: number }[];
  weekdays: { weekday: number; days: number; avgPresent: number }[]; // 1 = Пн … 7 = Нд, days the trainer trained
}

// A booking the member cancelled or moved themselves, with the reason they wrote
export interface Cancellation {
  bookingId: string;
  displayName: string;
  reason: string;
  cancelledAt: string | null;
  switchedToTime: string | null; // null = cancelled, otherwise moved to that time
  // A late cancellation: FULL = the training was spent, HALF = spent and half a single training goes back
  fee: { kind: "FULL" | "HALF"; waived: boolean; refundUah: number | null; refundDone: boolean } | null;
}

// What «Скасувати» would cost now: null = nothing; single = a single training (burns) rather than a pass
export interface CancelFeePreview {
  fee: "FULL" | "HALF" | null;
  single: boolean;
  refundUah: number | null;
}

// Half of a single personal / split training to give back after a late cancellation (the trainer returns it)
export interface CancelRefund {
  id: string;
  memberId: string;
  displayName: string;
  amountUah: number;
  method: PurchaseMethod;
  createdAt: string;
  localDate: string;
  slotTime: string;
  trainingType: TrainingType;
}

export interface MemberCancellation extends Cancellation {
  localDate: string;
  slotTime: string;
}

export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "REPLACED";

export interface MeResponse {
  type: "member" | "admin";
  id: string;
  memberCode?: string;
  displayName?: string;
  username?: string;
}

export interface SlotView {
  id: string;
  slotTime: string;
  status: "ACTIVE" | "CANCELLED";
  trainingType: TrainingType;
  capacity: number;
  bookedCount: number;
  isMyBooking: boolean;
  isMyVacancyAlert?: boolean;
  started?: boolean; // the training began: booking, cancelling and switching are over
  myGuest?: { name: string } | null; // the guest the member brings (on their own booking only)
  lateCancelled?: boolean; // the member cancelled it late and paid for it: no booking it again
}

// Personal / split the trainer assigned to this member (any day, any time); paid, bookable until the start
export interface AssignedSlotView {
  id: string;
  localDate: string;
  slotTime: string;
  trainingType: AssignedType;
  capacity: number;
  bookedCount: number;
  isMyBooking: boolean;
  spent: boolean; // already paid from a package (the trainer marked it)
  packageLeft: number; // trainings left in the member's packages of this type (0 = none: «Оплатити»)
  started: boolean;
}

// localDate null: no group training in the calendar ahead (assigned trainings may still be there)
export interface ScheduleNext {
  localDate: string | null;
  status: string | null;
  bookingWindowOpen: boolean;
  bookingOpenAt: string | null;
  bookingCloseAt: string | null;
  slots: SlotView[]; // group slots of the next group day
  assignedSlots?: AssignedSlotView[];
  groupPassLeft: number; // group trainings the member's pass holds for that day; 0 → «Записатися» offers to buy
  frozenUntil: string | null; // frozen (today or that day): the last frozen day, no «Записатись»
  serverTime: string;
  announcement?: string | null;
}

export interface AnnouncementExample {
  id: string;
  text: string;
  createdAt: string;
}

export interface Announcement {
  id: string;
  trainingDayId: string;
  topic: string | null;
  text: string | null;
  source: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface RegisterResponse {
  memberCode: string;
  recoveryCode: string;
}

export interface LoginResponse {
  memberCode: string;
  displayName: string;
}

export type AttendanceStatus = "PRESENT" | "ABSENT" | "UNMARKED";

export interface AdminParticipant {
  bookingId: string;
  displayName: string;
  attendanceStatus: AttendanceStatus;
  switchedFromTime: string | null; // moved here from that slot today
  guestOf: string | null; // a guest: who brought them (bookingId is then the guest's id)
}

export interface AdminSlotView {
  id: string;
  slotTime: string;
  status: "ACTIVE" | "CANCELLED";
  trainingType: TrainingType;
  capacity: number;
  bookedCount: number;
  participants: AdminParticipant[];
  cancellations: Cancellation[];
}

export interface AdminSchedule {
  localDate: string;
  status: string;
  bookingWindowOpen: boolean;
  bookingOpenAt: string;
  bookingCloseAt: string;
  slots: AdminSlotView[];
  serverTime: string;
}

// A past training day in the trainer's history; slots carry the same data as the today page
export interface HistoryDay {
  localDate: string;
  status: "SCHEDULED" | "CANCELLED";
  slots: AdminSlotView[];
}

export interface CalendarSlot {
  localDate: string;
  slotId: string;
  slotTime: string;
  trainingType: TrainingType;
  bookedCount: number;
  capacity: number;
  // Assigned members, assigned slots only. booked: false = cancelled it; spent: paid from a package already;
  // packageLeft: trainings of this type left
  members: { id: string; displayName: string; booked: boolean; spent: boolean; packageLeft: number }[];
}

export const api = {
  me: () => get<MeResponse>("/auth/me"),

  register: (displayName: string, pin: string) => post<RegisterResponse>("/auth/member/register", { displayName, pin }),

  login: (memberCode: string, pin: string) => post<LoginResponse>("/auth/member/login", { memberCode, pin }),

  // Clears the mg_authed flag for every logout (member and trainer), even if the request fails,
  // so `/` doesn't call the API with a dead session (401 in the console).
  // Logged out = no pushes: this browser's subscription is switched off on the server first, while the
  // session still says whose it is. The browser keeps it, so signing in again turns pushes back on
  logout: async () => {
    try {
      localStorage.removeItem("mg_authed");
    } catch {}
    const endpoint = await currentPushEndpoint();
    if (endpoint) await api.unsubscribePush(endpoint).catch(() => {});
    return post("/auth/logout");
  },

  forgotPin: (memberCode: string, recoveryCode: string, newPin: string) =>
    post<RegisterResponse>("/auth/member/forgot", { memberCode, recoveryCode, newPin }),

  getScheduleNext: () => get<ScheduleNext>("/schedule/next"),

  book: (slotId: string) => post("/bookings", { slotId }),

  // A free guest on the member's group booking (one per booking; takes a seat)
  addGuest: (slotId: string, name: string) => post("/bookings/guest", { slotId, name }),

  removeGuest: (slotId: string) => del("/bookings/guest", { slotId }),

  getCancelFee: (slotId: string) => get<CancelFeePreview>(`/bookings/cancel-fee?slotId=${encodeURIComponent(slotId)}`),

  cancelBooking: (slotId: string, reason: string) => del("/bookings/current", { slotId, reason }),

  switchSlot: (newSlotId: string, reason: string) => patch("/bookings/current", { newSlotId, reason }),

  adminLogin: (username: string, password: string) =>
    post<{ username: string }>("/auth/admin/login", { username, password }),

  checkTrainerInvite: (token: string) => get<{ valid: boolean }>(`/auth/admin/invite/${encodeURIComponent(token)}`),

  registerTrainer: (token: string, username: string, password: string) =>
    post<{ username: string }>("/auth/admin/register", { token, username, password }),

  changePassword: (currentPassword: string, newPassword: string) =>
    post("/auth/admin/password", { currentPassword, newPassword }),

  createTrainerInvite: () => post<{ id: string; token: string; expiresAt: string }>("/admin/trainer-invites"),

  getTrainerInvites: () => get<TrainerInvite[]>("/admin/trainer-invites"),

  revokeTrainerInvite: (id: string) => del(`/admin/trainer-invites/${id}`),

  // Clients (and cash requests waiting) go to `transferToId`; trainings not over yet are cancelled
  disableTrainer: (id: string, transferToId: string) =>
    post<{ movedClients: number; cancelledTrainings: number }>(`/admin/trainers/${id}/disable`, { transferToId }),

  getAdminSchedule: () => get<AdminSchedule | null>("/admin/schedule"),

  // Newest first; pass the returned nextBefore to load older days
  getHistory: (before?: string) =>
    get<{ days: HistoryDay[]; nextBefore: string | null }>(`/admin/history${before ? `?before=${before}` : ""}`),

  cancelSlot: (slotId: string) => patch(`/admin/slots/${slotId}`, { status: "CANCELLED" }),

  cancelTrainingDay: (date: string) => put(`/admin/training-days/${date}`, { status: "CANCELLED" }),

  // Continue paying a pending LiqPay purchase. { status: "PAID" } — a previous attempt already succeeded
  checkoutPurchase: (purchaseId: string) =>
    post<LiqPayCheckout | { status: "PAID" }>("/payments/checkout", { purchaseId }),

  getPurchases: () => get<MyPurchases>("/purchases"),

  // «Заморозити абонемент»: the member asks, the trainer approves (the same for «Розморозити»)
  getMyFreeze: () => get<MyFreeze>("/freezes"),
  requestFreeze: () => post("/freezes"),
  cancelFreezeRequest: () => post("/freezes/cancel"),
  requestUnfreeze: () => post("/freezes/unfreeze"),

  getStats: () => get<TrainerStats>("/admin/stats"),

  // Late cancellations: «Не списувати», and the half refunds the trainer returns
  waiveCancelFee: (bookingId: string) => post(`/admin/bookings/${bookingId}/waive-fee`),
  getPendingCancelRefunds: () => get<CancelRefund[]>("/admin/cancel-refunds/pending"),
  markCancelRefundDone: (id: string) => post(`/admin/cancel-refunds/${id}/done`),

  getPendingFreezes: () => get<FreezeRequest[]>("/admin/freezes/pending"),
  decideFreeze: (freeze: FreezeRequest, approve: boolean) =>
    post(
      `/admin/freezes/${freeze.id}/${freeze.kind === "unfreeze" ? "unfreeze/" : ""}${approve ? "approve" : "reject"}`,
    ),
  getMemberFreezes: (memberId: string) => get<MemberFreeze[]>(`/admin/members/${memberId}/freezes`),

  // Trainer: cash requests of own clients, a client's cards / packages / purchases
  getPendingCash: () => get<CashRequest[]>("/admin/purchases/pending"),

  confirmCash: (purchaseId: string) => post(`/admin/purchases/${purchaseId}/confirm`),

  rejectCash: (purchaseId: string) => post(`/admin/purchases/${purchaseId}/reject`),

  getStrayPayments: () => get<StrayPayment[]>("/admin/payments/stray"),

  markPaymentHandled: (paymentId: string) => post(`/admin/payments/${paymentId}/handled`),

  getMemberPurchases: (memberId: string) => get<MemberPurchases>(`/admin/members/${memberId}/purchases`),

  addClubCard: (memberId: string, priceItemId: string, activate: boolean) =>
    post(`/admin/members/${memberId}/club-card`, { priceItemId, activate }),

  activateClubCard: (memberId: string, cardId: string) =>
    post(`/admin/members/${memberId}/club-cards/${cardId}/activate`),

  // slotId: a group pass bought from «Записатися» (cash: booked at once; LiqPay: booked once paid)
  createPurchase: (priceItemIds: string[], method: PurchaseMethod, slotId?: string) =>
    post<{ purchaseId: string; checkout?: LiqPayCheckout | { status: "PAID" } }>("/purchases", {
      priceItemIds,
      method,
      slotId,
    }),

  cancelPurchase: (purchaseId: string) => post(`/purchases/${purchaseId}/cancel`),

  getPaymentStatus: (orderId: string) =>
    get<{ status: PaymentStatus; errCode?: string; expiresAt?: string; booked?: boolean }>(
      `/payments/status?order=${encodeURIComponent(orderId)}`,
    ),

  getMembers: () =>
    get<AdminMember[]>("/admin/members").then((list) =>
      list.sort((a, b) => nameCollator.compare(a.displayName, b.displayName)),
    ),

  getTrainers: () => get<Trainer[]>("/admin/trainers"),

  assignTrainer: (memberId: string, trainerId: string) =>
    patch<{ id: string; trainerId: string }>(`/admin/members/${memberId}/trainer`, { trainerId }),

  getMember: (memberId: string) => get<AdminMember>(`/admin/members/${memberId}`),

  getMemberVisits: (memberId: string) => get<MemberVisit[]>(`/admin/members/${memberId}/visits`),

  getMemberCancellations: (memberId: string) => get<MemberCancellation[]>(`/admin/members/${memberId}/cancellations`),

  getSlotCancellations: (slotId: string) => get<Cancellation[]>(`/admin/slots/${slotId}/cancellations`),

  updateMemberNote: (memberId: string, note: string) =>
    patch<{ id: string; trainerNote: string | null }>(`/admin/members/${memberId}/note`, { note }),

  getPrices: () => get<{ items: PriceItem[]; changes: PriceChange[] }>("/admin/prices"),

  // 409 when another trainer changed it meanwhile: error.body has the current amountUah and updatedBy
  updatePrice: (id: string, amountUah: number, expectedAmountUah: number) =>
    patch<{ id: string; amountUah: number }>(`/admin/prices/${id}`, { amountUah, expectedAmountUah }),

  getCalendar: (month: string) => get<CalendarSlot[]>(`/admin/calendar?month=${month}`),

  // «Розклад групових»: the signed-in trainer's regular group trainings
  getMySchedule: () => get<TrainerSchedule>("/admin/my-schedule"),

  // Saved, plus what was put in the calendar: trainings added, and the ones left out with a reason
  saveMySchedule: (schedule: TrainerSchedule) =>
    put<TrainerSchedule & { added?: number; skipped?: SkippedTraining[] }>("/admin/my-schedule", schedule),

  upsertGroupSlot: (date: string, slotTime: string) =>
    put(`/admin/training-days/${date}/slots/${encodeURIComponent(slotTime)}`),

  createAssignedSlot: (date: string, body: { slotTime: string; trainingType: TrainingType; memberIds: string[] }) =>
    post<Ok & { slotId: string }>(`/admin/training-days/${date}/assigned-slots`, body),

  updateSlotMembers: (slotId: string, memberIds: string[]) => put(`/admin/slots/${slotId}/members`, { memberIds }),

  markAllAttendance: (slotId: string) => put<{ marked: number }>(`/admin/slots/${slotId}/attendance/all`),

  updateAttendance: (bookingId: string, status: AttendanceStatus) =>
    patch(`/admin/bookings/${bookingId}/attendance`, { status }),

  // A participant's mark: a member's booking, or a guest (nothing is spent for a guest)
  updateParticipantAttendance: (p: { bookingId: string; guestOf: string | null }, status: AttendanceStatus) =>
    patch(`/admin/${p.guestOf ? "guests" : "bookings"}/${p.bookingId}/attendance`, { status }),

  getVapidPublicKey: () => get<{ publicKey: string }>("/push/vapid-public-key"),

  subscribePush: (sub: { endpoint: string; p256dh: string; auth: string }) => post("/push/subscriptions", sub),

  unsubscribePush: (endpoint: string) => del("/push/subscriptions", { endpoint }),

  subscribeVacancy: (slotId: string) => put(`/slots/${slotId}/vacancy-alert`),

  unsubscribeVacancy: (slotId: string) => del(`/slots/${slotId}/vacancy-alert`),

  listAnnouncementExamples: () => get<AnnouncementExample[]>("/admin/announcement-examples"),

  addAnnouncementExample: (text: string) => post<AnnouncementExample>("/admin/announcement-examples", { text }),

  deleteAnnouncementExample: (id: string) => del(`/admin/announcement-examples/${id}`),

  getAnnouncement: (date: string) => get<Announcement>(`/admin/announcements/${date}`),

  generateAnnouncement: (date: string) => post<Announcement>(`/admin/announcements/${date}/generate`),

  updateAnnouncementText: (date: string, text: string) =>
    put<Announcement>(`/admin/announcements/${date}/text`, { text }),

  publishAnnouncement: (date: string) => post<Announcement>(`/admin/announcements/${date}/publish`),

  unpublishAnnouncement: (date: string) => post<Announcement>(`/admin/announcements/${date}/unpublish`),
};
