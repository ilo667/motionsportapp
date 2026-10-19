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

export interface MeResponse {
  type: "member" | "admin";
  id: string;
  memberCode?: string;
  displayName?: string;
  username?: string;
}

export interface SlotView {
  id: string;
  slotTime: "19:00" | "20:00";
  status: "ACTIVE" | "CANCELLED";
  capacity: number;
  bookedCount: number;
  isMyBooking: boolean;
}

export interface ScheduleNext {
  localDate: string;
  status: string;
  bookingWindowOpen: boolean;
  bookingOpenAt: string;
  bookingCloseAt: string;
  slots: SlotView[];
  serverTime: string;
}

export interface RegisterResponse {
  memberCode: string;
  recoveryCode: string;
}

export interface LoginResponse {
  memberCode: string;
  displayName: string;
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

  getScheduleNext: () => request<ScheduleNext>("/schedule/next"),

  book: (slotId: string) =>
    request<{ ok: boolean }>("/bookings", {
      method: "POST",
      body: JSON.stringify({ slotId }),
    }),

  cancelBooking: () =>
    request<{ ok: boolean }>("/bookings/current", { method: "DELETE" }),

  switchSlot: (newSlotId: string) =>
    request<{ ok: boolean }>("/bookings/current", {
      method: "PATCH",
      body: JSON.stringify({ newSlotId }),
    }),
};