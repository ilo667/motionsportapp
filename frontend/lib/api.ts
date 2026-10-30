import type {
  AdminMember,
  AdminSchedule,
  Announcement,
  AnnouncementExample,
  AttendanceStatus,
  CalendarSlot,
  CancelFeePreview,
  Cancellation,
  CancelRefund,
  CashRequest,
  FreezeRequest,
  HistoryDay,
  LiqPayCheckout,
  LoginResponse,
  MemberCancellation,
  MemberFreeze,
  MemberPurchases,
  MemberVisit,
  MeResponse,
  MyFreeze,
  MyPurchases,
  PaymentStatus,
  PriceChange,
  PriceItem,
  PurchaseMethod,
  RegisterResponse,
  ScheduleNext,
  SkippedTraining,
  StrayPayment,
  Trainer,
  TrainerInvite,
  TrainerSchedule,
  TrainerStats,
  TrainingType,
} from "./apiTypes";

// Callers import the types from here, together with `api`
export type * from "./apiTypes";

const BASE = "/api";

type Ok = { ok: boolean };

// A non-2xx answer; show it to people through errorText, never the raw message
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// undefined when there was no HTTP answer (network failure)
export function statusOf(err: unknown): number | undefined {
  return err instanceof ApiError ? err.status : undefined;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message ?? res.statusText, res.status, body);
  }
  // NestJS sends an empty body for null. No runtime schema: both sides live in this repo and change together.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T = Ok>(path: string, body?: unknown) => request<T>(path, "POST", body);
const put = <T = Ok>(path: string, body?: unknown) => request<T>(path, "PUT", body);
const patch = <T = Ok>(path: string, body?: unknown) => request<T>(path, "PATCH", body);
const del = <T = Ok>(path: string, body?: unknown) => request<T>(path, "DELETE", body);

// getRegistration(), not serviceWorker.ready: ready never resolves without a registered worker
async function currentPushEndpoint(): Promise<string | null> {
  try {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager?.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

// Numeric ("2" before "10"), Ukrainian alphabet order
const nameCollator = new Intl.Collator("uk", { numeric: true, sensitivity: "base" });

export const api = {
  me: () => get<MeResponse>("/auth/me"),

  register: (displayName: string, pin: string) => post<RegisterResponse>("/auth/member/register", { displayName, pin }),

  login: (memberCode: string, pin: string) => post<LoginResponse>("/auth/member/login", { memberCode, pin }),

  // Clears mg_authed even if the request fails, so `/` won't call the API with a dead session.
  // Unsubscribes push on the server first, while the session still says whose it is; the browser keeps it.
  logout: async () => {
    try {
      localStorage.removeItem("mg_authed");
    } catch {}
    const endpoint = await currentPushEndpoint();
    // Best effort: must not block the logout
    if (endpoint) await api.unsubscribePush(endpoint).catch(() => {});
    return post("/auth/logout");
  },

  forgotPin: (memberCode: string, recoveryCode: string, newPin: string) =>
    post<RegisterResponse>("/auth/member/forgot", { memberCode, recoveryCode, newPin }),

  getScheduleNext: () => get<ScheduleNext>("/schedule/next"),

  book: (slotId: string) => post("/bookings", { slotId }),

  // One free guest per booking; takes a seat
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

  // Clients and pending cash purchases move to transferToId; trainings not over yet are cancelled
  disableTrainer: (id: string, transferToId: string) =>
    post<{ movedClients: number; cancelledTrainings: number }>(`/admin/trainers/${id}/disable`, { transferToId }),

  getAdminSchedule: () => get<AdminSchedule | null>("/admin/schedule"),

  getHistory: (before?: string) =>
    get<{ days: HistoryDay[]; nextBefore: string | null }>(`/admin/history${before ? `?before=${before}` : ""}`),

  cancelSlot: (slotId: string) => patch(`/admin/slots/${slotId}`, { status: "CANCELLED" }),

  cancelTrainingDay: (date: string) => put(`/admin/training-days/${date}`, { status: "CANCELLED" }),

  // { status: "PAID" }: a previous attempt already succeeded
  checkoutPurchase: (purchaseId: string) =>
    post<LiqPayCheckout | { status: "PAID" }>("/payments/checkout", { purchaseId }),

  getPurchases: () => get<MyPurchases>("/purchases"),

  // The member asks, the trainer approves (freeze and early unfreeze)
  getMyFreeze: () => get<MyFreeze>("/freezes"),
  requestFreeze: () => post("/freezes"),
  cancelFreezeRequest: () => post("/freezes/cancel"),
  requestUnfreeze: () => post("/freezes/unfreeze"),

  getStats: () => get<TrainerStats>("/admin/stats"),

  waiveCancelFee: (bookingId: string) => post(`/admin/bookings/${bookingId}/waive-fee`),
  getPendingCancelRefunds: () => get<CancelRefund[]>("/admin/cancel-refunds/pending"),
  markCancelRefundDone: (id: string) => post(`/admin/cancel-refunds/${id}/done`),

  getPendingFreezes: () => get<FreezeRequest[]>("/admin/freezes/pending"),
  decideFreeze: (freeze: FreezeRequest, approve: boolean) =>
    post(
      `/admin/freezes/${freeze.id}/${freeze.kind === "unfreeze" ? "unfreeze/" : ""}${approve ? "approve" : "reject"}`,
    ),
  getMemberFreezes: (memberId: string) => get<MemberFreeze[]>(`/admin/members/${memberId}/freezes`),

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

  // slotId: group pass bought while booking; cash books at once, LiqPay once paid
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

  // Compare-and-set: 409 body carries the current amountUah and updatedBy
  updatePrice: (id: string, amountUah: number, expectedAmountUah: number) =>
    patch<{ id: string; amountUah: number }>(`/admin/prices/${id}`, { amountUah, expectedAmountUah }),

  getCalendar: (month: string) => get<CalendarSlot[]>(`/admin/calendar?month=${month}`),

  getMySchedule: () => get<TrainerSchedule>("/admin/my-schedule"),

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

  // A guest's mark spends nothing
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
