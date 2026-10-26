const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
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
}

// A training the client was booked on (up to today) and the trainer's mark
export interface MemberVisit {
  bookingId: string;
  localDate: string;
  slotTime: string;
  trainingType: TrainingType;
  attendance: "PRESENT" | "ABSENT" | "UNMARKED";
}

export interface Trainer {
  id: string;
  username: string;
  createdAt: string;
  invitedBy: string | null; // null = added by the seed script
}

// An invite link still waiting to be used (any trainer's)
export interface TrainerInvite {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

// Price list shared by all trainers (admin only for now; payments don't use it yet)
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

// A trainer's regular group trainings («Мій розклад»): times per weekday (1 = Пн … 7 = Нд), one opening time for
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

// A booking the member cancelled or moved themselves, with the reason they wrote
export interface Cancellation {
  bookingId: string;
  displayName: string;
  reason: string;
  cancelledAt: string | null;
  switchedToTime: string | null; // null = cancelled, otherwise moved to that time
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
}

// Personal / split the trainer assigned to this member (any day, any time); paid, bookable until the start
export interface AssignedSlotView {
  id: string;
  localDate: string;
  slotTime: string;
  trainingType: Exclude<TrainingType, "групові">;
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
  me: () => request<MeResponse>("/auth/me"),

  register: (displayName: string, pin: string) =>
    request<RegisterResponse>("/auth/member/register", {
      method: "POST",
      body: JSON.stringify({ displayName, pin }),
    }),

  login: (memberCode: string, pin: string) =>
    request<LoginResponse>("/auth/member/login", {
      method: "POST",
      body: JSON.stringify({ memberCode, pin }),
    }),

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
    return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
  },

  forgotPin: (memberCode: string, recoveryCode: string, newPin: string) =>
    request<RegisterResponse>("/auth/member/forgot", {
      method: "POST",
      body: JSON.stringify({ memberCode, recoveryCode, newPin }),
    }),

  getScheduleNext: () => request<ScheduleNext>("/schedule/next"),

  book: (slotId: string) =>
    request<{ ok: boolean }>("/bookings", {
      method: "POST",
      body: JSON.stringify({ slotId }),
    }),

  cancelBooking: (slotId: string, reason: string) =>
    request<{ ok: boolean }>("/bookings/current", {
      method: "DELETE",
      body: JSON.stringify({ slotId, reason }),
    }),

  switchSlot: (newSlotId: string, reason: string) =>
    request<{ ok: boolean }>("/bookings/current", {
      method: "PATCH",
      body: JSON.stringify({ newSlotId, reason }),
    }),

  adminLogin: (username: string, password: string) =>
    request<{ username: string }>("/auth/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  checkTrainerInvite: (token: string) => request<{ valid: boolean }>(`/auth/admin/invite/${encodeURIComponent(token)}`),

  registerTrainer: (token: string, username: string, password: string) =>
    request<{ username: string }>("/auth/admin/register", {
      method: "POST",
      body: JSON.stringify({ token, username, password }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/auth/admin/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  createTrainerInvite: () =>
    request<{ id: string; token: string; expiresAt: string }>("/admin/trainer-invites", { method: "POST" }),

  getTrainerInvites: () => request<TrainerInvite[]>("/admin/trainer-invites"),

  revokeTrainerInvite: (id: string) => request<{ ok: boolean }>(`/admin/trainer-invites/${id}`, { method: "DELETE" }),

  getAdminSchedule: () => request<AdminSchedule | null>("/admin/schedule"),

  // Newest first; pass the returned nextBefore to load older days
  getHistory: (before?: string) =>
    request<{ days: HistoryDay[]; nextBefore: string | null }>(`/admin/history${before ? `?before=${before}` : ""}`),

  cancelSlot: (slotId: string) =>
    request<{ ok: boolean }>(`/admin/slots/${slotId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "CANCELLED" }),
    }),

  cancelTrainingDay: (date: string) =>
    request<{ ok: boolean }>(`/admin/training-days/${date}`, {
      method: "PUT",
      body: JSON.stringify({ status: "CANCELLED" }),
    }),

  // Continue paying a pending LiqPay purchase. { status: "PAID" } — a previous attempt already succeeded
  checkoutPurchase: (purchaseId: string) =>
    request<LiqPayCheckout | { status: "PAID" }>("/payments/checkout", {
      method: "POST",
      body: JSON.stringify({ purchaseId }),
    }),

  getPurchases: () => request<MyPurchases>("/purchases"),

  // Trainer: cash requests of own clients, a client's cards / packages / purchases
  getPendingCash: () => request<CashRequest[]>("/admin/purchases/pending"),

  confirmCash: (purchaseId: string) =>
    request<{ ok: boolean }>(`/admin/purchases/${purchaseId}/confirm`, { method: "POST" }),

  rejectCash: (purchaseId: string) =>
    request<{ ok: boolean }>(`/admin/purchases/${purchaseId}/reject`, { method: "POST" }),

  getStrayPayments: () => request<StrayPayment[]>("/admin/payments/stray"),

  markPaymentHandled: (paymentId: string) =>
    request<{ ok: boolean }>(`/admin/payments/${paymentId}/handled`, { method: "POST" }),

  getMemberPurchases: (memberId: string) => request<MemberPurchases>(`/admin/members/${memberId}/purchases`),

  addClubCard: (memberId: string, priceItemId: string, activate: boolean) =>
    request<{ ok: boolean }>(`/admin/members/${memberId}/club-card`, {
      method: "POST",
      body: JSON.stringify({ priceItemId, activate }),
    }),

  activateClubCard: (memberId: string, cardId: string) =>
    request<{ ok: boolean }>(`/admin/members/${memberId}/club-cards/${cardId}/activate`, { method: "POST" }),

  // slotId: a group pass bought from «Записатися» (cash: booked at once; LiqPay: booked once paid)
  createPurchase: (priceItemIds: string[], method: PurchaseMethod, slotId?: string) =>
    request<{ purchaseId: string; checkout?: LiqPayCheckout | { status: "PAID" } }>("/purchases", {
      method: "POST",
      body: JSON.stringify({ priceItemIds, method, slotId }),
    }),

  cancelPurchase: (purchaseId: string) =>
    request<{ ok: boolean }>(`/purchases/${purchaseId}/cancel`, { method: "POST" }),

  getPaymentStatus: (orderId: string) =>
    request<{ status: PaymentStatus; errCode?: string; expiresAt?: string; booked?: boolean }>(
      `/payments/status?order=${encodeURIComponent(orderId)}`,
    ),

  getMembers: () =>
    request<AdminMember[]>("/admin/members").then((list) =>
      list.sort((a, b) => nameCollator.compare(a.displayName, b.displayName)),
    ),

  getTrainers: () => request<Trainer[]>("/admin/trainers"),

  assignTrainer: (memberId: string, trainerId: string) =>
    request<{ id: string; trainerId: string }>(`/admin/members/${memberId}/trainer`, {
      method: "PATCH",
      body: JSON.stringify({ trainerId }),
    }),

  getMember: (memberId: string) => request<AdminMember>(`/admin/members/${memberId}`),

  getMemberVisits: (memberId: string) => request<MemberVisit[]>(`/admin/members/${memberId}/visits`),

  getMemberCancellations: (memberId: string) =>
    request<MemberCancellation[]>(`/admin/members/${memberId}/cancellations`),

  getSlotCancellations: (slotId: string) => request<Cancellation[]>(`/admin/slots/${slotId}/cancellations`),

  updateMemberNote: (memberId: string, note: string) =>
    request<{ id: string; trainerNote: string | null }>(`/admin/members/${memberId}/note`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    }),

  getPrices: () => request<{ items: PriceItem[]; changes: PriceChange[] }>("/admin/prices"),

  // 409 when another trainer changed it meanwhile: error.body has the current amountUah and updatedBy
  updatePrice: (id: string, amountUah: number, expectedAmountUah: number) =>
    request<{ id: string; amountUah: number }>(`/admin/prices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ amountUah, expectedAmountUah }),
    }),

  getCalendar: (month: string) => request<CalendarSlot[]>(`/admin/calendar?month=${month}`),

  // «Мій розклад»: the signed-in trainer's regular group trainings
  getMySchedule: () => request<TrainerSchedule>("/admin/my-schedule"),

  // Saved, plus what was put in the calendar: trainings added, and the ones left out with a reason
  saveMySchedule: (schedule: TrainerSchedule) =>
    request<TrainerSchedule & { added?: number; skipped?: SkippedTraining[] }>("/admin/my-schedule", {
      method: "PUT",
      body: JSON.stringify(schedule),
    }),

  upsertGroupSlot: (date: string, slotTime: string) =>
    request<{ ok: boolean }>(`/admin/training-days/${date}/slots/${encodeURIComponent(slotTime)}`, {
      method: "PUT",
    }),

  createAssignedSlot: (date: string, body: { slotTime: string; trainingType: TrainingType; memberIds: string[] }) =>
    request<{ ok: boolean; slotId: string }>(`/admin/training-days/${date}/assigned-slots`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateSlotMembers: (slotId: string, memberIds: string[]) =>
    request<{ ok: boolean }>(`/admin/slots/${slotId}/members`, {
      method: "PUT",
      body: JSON.stringify({ memberIds }),
    }),

  markAllAttendance: (slotId: string) =>
    request<{ marked: number }>(`/admin/slots/${slotId}/attendance/all`, {
      method: "PUT",
    }),

  updateAttendance: (bookingId: string, status: AttendanceStatus) =>
    request<{ ok: boolean }>(`/admin/bookings/${bookingId}/attendance`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  getVapidPublicKey: () => request<{ publicKey: string }>("/push/vapid-public-key"),

  subscribePush: (sub: { endpoint: string; p256dh: string; auth: string }) =>
    request<{ ok: boolean }>("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(sub),
    }),

  unsubscribePush: (endpoint: string) =>
    request<{ ok: boolean }>("/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),

  subscribeVacancy: (slotId: string) => request<{ ok: boolean }>(`/slots/${slotId}/vacancy-alert`, { method: "PUT" }),

  unsubscribeVacancy: (slotId: string) =>
    request<{ ok: boolean }>(`/slots/${slotId}/vacancy-alert`, { method: "DELETE" }),

  listAnnouncementExamples: () => request<AnnouncementExample[]>("/admin/announcement-examples"),

  addAnnouncementExample: (text: string) =>
    request<AnnouncementExample>("/admin/announcement-examples", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  deleteAnnouncementExample: (id: string) =>
    request<{ ok: boolean }>(`/admin/announcement-examples/${id}`, { method: "DELETE" }),

  getAnnouncement: (date: string) => request<Announcement>(`/admin/announcements/${date}`),

  generateAnnouncement: (date: string) =>
    request<Announcement>(`/admin/announcements/${date}/generate`, { method: "POST" }),

  updateAnnouncementText: (date: string, text: string) =>
    request<Announcement>(`/admin/announcements/${date}/text`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),

  publishAnnouncement: (date: string) =>
    request<Announcement>(`/admin/announcements/${date}/publish`, { method: "POST" }),

  unpublishAnnouncement: (date: string) =>
    request<Announcement>(`/admin/announcements/${date}/unpublish`, { method: "POST" }),
};
