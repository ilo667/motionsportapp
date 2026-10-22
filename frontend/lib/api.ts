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
  return res.json() as Promise<T>;
}

export type TrainingType = "групові" | "індивідуальні" | "спліт";

export interface AdminMember {
  id: string;
  memberCode: string;
  displayName: string;
  trainerNote: string | null;
  createdAt: string;
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

// Individual / split the coach assigned to this member (any day, any time); paid, bookable until the start
export interface PersonalSlotView {
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

export interface ScheduleNext {
  localDate: string;
  status: string;
  bookingWindowOpen: boolean;
  bookingOpenAt: string;
  bookingCloseAt: string;
  slots: SlotView[]; // group slots of the next group day
  personalSlots?: PersonalSlotView[];
  serverTime: string;
  announcement?: string | null;
  isDemoMode?: boolean;
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
  approvedAt: string | null;
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
}

export interface AdminSlotView {
  id: string;
  slotTime: string;
  status: "ACTIVE" | "CANCELLED";
  trainingType: TrainingType;
  capacity: number;
  bookedCount: number;
  participants: AdminParticipant[];
}

export interface AdminSchedule {
  localDate: string;
  status: string;
  bookingWindowOpen: boolean;
  bookingOpenAt: string;
  bookingCloseAt: string;
  slots: AdminSlotView[];
  serverTime: string;
  isDemoMode?: boolean;
}

export interface CalendarSlot {
  localDate: string;
  slotId: string;
  slotTime: string;
  trainingType: TrainingType;
  bookedCount: number;
  capacity: number;
  // Assigned members, personal slots only. paymentStatus: PENDING = on LiqPay (seat held), null = has not started paying
  members: { id: string; displayName: string; paymentStatus: "PAID" | "PENDING" | null }[];
}

/** @deprecated use CalendarSlot */
export type CalendarDay = CalendarSlot;

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

  cancelBooking: (slotId: string, reason: string, reasonAt: Date) =>
    request<{ ok: boolean }>("/bookings/current", {
      method: "DELETE",
      body: JSON.stringify({ slotId, reason, reasonAt: reasonAt.toISOString() }),
    }),

  switchSlot: (newSlotId: string, reason: string, reasonAt: Date) =>
    request<{ ok: boolean }>("/bookings/current", {
      method: "PATCH",
      body: JSON.stringify({ newSlotId, reason, reasonAt: reasonAt.toISOString() }),
    }),

  adminLogin: (username: string, password: string) =>
    request<{ username: string }>("/auth/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  getAdminSchedule: () => request<AdminSchedule>("/admin/schedule"),

  cancelSlot: (slotId: string) =>
    request<{ ok: boolean }>(`/admin/slots/${slotId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "CANCELLED" }),
    }),

  cancelTrainingDay: (date: string) =>
    request<{ ok: boolean }>(`/admin/training-days/${date}`, {
      method: "PUT",
      body: JSON.stringify({ status: "CANCELLED", isException: true }),
    }),

  upsertTrainingDay: (date: string, body: { status: string; trainingType?: TrainingType; isException?: boolean }) =>
    request<{ ok: boolean }>(`/admin/training-days/${date}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  createCheckout: (slotId: string) =>
    // { status: "PAID" } — a previous attempt for this booking already succeeded, no redirect needed
    request<{ data: string; signature: string } | { status: "PAID" }>("/payments/checkout", {
      method: "POST",
      body: JSON.stringify({ slotId }),
    }),

  getPaymentStatus: (orderId: string) =>
    request<{ status: PaymentStatus; errCode?: string; expiresAt?: string }>(`/payments/status?order=${encodeURIComponent(orderId)}`),

  getMembers: () => request<AdminMember[]>("/admin/members"),

  updateMemberNote: (memberId: string, note: string) =>
    request<{ id: string; trainerNote: string | null }>(`/admin/members/${memberId}/note`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    }),

  getCalendar: (month: string) =>
    request<CalendarSlot[]>(`/admin/calendar?month=${month}`),

  upsertGroupSlot: (date: string, slotTime: string) =>
    request<{ ok: boolean }>(`/admin/training-days/${date}/slots/${encodeURIComponent(slotTime)}`, {
      method: "PUT",
    }),

  createPersonalSlot: (date: string, body: { slotTime: string; trainingType: TrainingType; memberIds: string[] }) =>
    request<{ ok: boolean; slotId: string }>(`/admin/training-days/${date}/personal-slots`, {
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

  setAnnouncementTopic: (date: string, topic: string) =>
    request<Announcement>(`/admin/announcements/${date}/topic`, {
      method: "PUT",
      body: JSON.stringify({ topic }),
    }),

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

  getDemoInfo: () =>
    request<{ isDemoMode: boolean; scenario: string | null; clockOverride: string | null }>("/demo/info"),

  setDemoScenario: (scenario: string) =>
    request<{ ok: boolean; scenario: string }>("/demo/scenario", {
      method: "POST",
      body: JSON.stringify({ scenario }),
    }),

  resetDemo: () =>
    request<{ ok: boolean }>("/demo/reset", { method: "POST" }),
};