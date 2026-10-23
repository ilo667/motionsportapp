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
}

export interface Trainer {
  id: string;
  username: string;
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

export interface PriceChange {
  id: string;
  title: string;
  optionLabel: string | null;
  oldAmountUah: number;
  newAmountUah: number;
  changedBy: string;
  changedAt: string;
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
  myPaymentStatus?: "PENDING" | "PAID" | null;
  isMyVacancyAlert?: boolean;
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
  myPaymentStatus: "PENDING" | "PAID" | null;
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
  // Assigned members, assigned slots only. paymentStatus: PENDING = on LiqPay (seat held), null = has not started paying
  members: { id: string; displayName: string; paymentStatus: "PAID" | "PENDING" | null }[];
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

  logout: () =>
    request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

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

  getAdminSchedule: () => request<AdminSchedule | null>("/admin/schedule"),

  // Newest first; pass the returned nextBefore to load older days
  getHistory: (before?: string) =>
    request<{ days: HistoryDay[]; nextBefore: string | null }>(
      `/admin/history${before ? `?before=${before}` : ""}`,
    ),

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

  createCheckout: (slotId: string) =>
    // { status: "PAID" } — a previous attempt for this booking already succeeded, no redirect needed
    request<{ data: string; signature: string } | { status: "PAID" }>("/payments/checkout", {
      method: "POST",
      body: JSON.stringify({ slotId }),
    }),

  getPaymentStatus: (orderId: string) =>
    request<{ status: PaymentStatus; errCode?: string; expiresAt?: string }>(`/payments/status?order=${encodeURIComponent(orderId)}`),

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

  getMemberCancellations: (memberId: string) =>
    request<MemberCancellation[]>(`/admin/members/${memberId}/cancellations`),

  getSlotCancellations: (slotId: string) =>
    request<Cancellation[]>(`/admin/slots/${slotId}/cancellations`),

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

  getCalendar: (month: string) =>
    request<CalendarSlot[]>(`/admin/calendar?month=${month}`),

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

  getVapidPublicKey: () =>
    request<{ publicKey: string }>("/push/vapid-public-key"),

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

  subscribeVacancy: (slotId: string) =>
    request<{ ok: boolean }>(`/slots/${slotId}/vacancy-alert`, { method: "PUT" }),

  unsubscribeVacancy: (slotId: string) =>
    request<{ ok: boolean }>(`/slots/${slotId}/vacancy-alert`, { method: "DELETE" }),

  listAnnouncementExamples: () =>
    request<AnnouncementExample[]>("/admin/announcement-examples"),

  addAnnouncementExample: (text: string) =>
    request<AnnouncementExample>("/admin/announcement-examples", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  deleteAnnouncementExample: (id: string) =>
    request<{ ok: boolean }>(`/admin/announcement-examples/${id}`, { method: "DELETE" }),

  getAnnouncement: (date: string) =>
    request<Announcement>(`/admin/announcements/${date}`),

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