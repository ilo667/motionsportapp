// Request / response types of lib/api.ts

export type TrainingType = "group" | "personal" | "split";

export interface AdminMember {
  id: string;
  memberCode: string;
  displayName: string;
  trainerNote: string | null;
  trainerId: string | null; // null = unassigned, visible to every trainer
  createdAt: string;
  recentCancellations: number; // own cancellations, last 30 days, moves excluded
  // active: valid until `until`; waiting: must be activated by `until` or it burns
  clubCard: { state: "waiting" | "active"; until: string } | null;
  packagesLeft: { trainingType: TrainingType; left: number }[]; // usable packages only
  frozenUntil: string | null; // last frozen day, if frozen today
}

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
  disabledAt: string | null;
  disabledBy: string | null;
}

// Unused invite link of any trainer
export interface TrainerInvite {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

// One price list for all trainers; purchases copy the amounts
export type PriceSection = "club_card" | "assigned" | "group";

export interface PriceItem {
  id: string;
  section: PriceSection;
  title: string;
  optionLabel: string | null; // null for a single-option item
  amountUah: number;
  updatedBy: string | null; // trainer username; null = never changed since the seed
  updatedAt: string | null;
}

// «Розклад групових»: weekday 1 = Mon … 7 = Sun; autoCreate adds the trainings 3 weeks ahead
export interface TrainerSchedule {
  bookingOpensAt: string; // "HH:MM"
  autoCreate: boolean;
  times: { weekday: number; slotTime: string }[];
}

// A schedule training not added on save
export interface SkippedTraining {
  date: string; // "YYYY-MM-DD"
  slotTime: string;
  reason: "cancelled" | "taken";
}

// Member-facing: no trainer names
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

// Purchases. Nothing starts on payment: a card waits for the trainer to activate it, a package for its first
// attendance mark. Not activated within a month, it burns.

export type PurchaseMethod = "LIQPAY" | "CASH";
export type AssignedType = Exclude<TrainingType, "group">;

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

// Dates (YYYY-MM-DD) exist only once activated; narrowing on `state` proves it (backend: purchases/validity.ts)
type NotActivated = { validFrom: null; validUntil: null };
type Activated = { validFrom: string; validUntil: string };

// Current card; activateBy = last day to activate a waiting one
export type ClubCard = { id: string; label: string; activateBy: string } & (
  { state: "waiting"; validUntil: null } | { state: "active"; validUntil: string }
);

export type AdminClubCard = { id: string; label: string; activateBy: string; source: "purchase" | "manual" } & (
  ({ state: "waiting" | "burned" } & NotActivated) | ({ state: "active" | "expired" } & Activated)
);

// The first attendance mark activates a package, so a used one is always activated
export type TrainingPackage = {
  id: string;
  trainingType: TrainingType;
  title: string;
  total: number;
  left: number;
  purchasedOn: string;
  activateBy: string;
  createdAt: string;
} & (
  | { state: "waiting" | "burned"; activatedOn: null; validUntil: null }
  | { state: "active" | "expired" | "used"; activatedOn: string; validUntil: string }
);

export interface PurchaseLine {
  section?: PriceSection;
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

// Money that arrived after its purchase ended; handled by hand
export interface StrayPayment {
  paymentId: string;
  memberId: string;
  displayName: string;
  amountUah: number;
  liqpayPaymentId: string | null; // to find it in the LiqPay cabinet for a refund
  paidAt: string;
  lines: PurchaseLine[];
}

export interface CashRequest extends Purchase {
  memberId: string;
  displayName: string;
}

export interface MemberPurchases {
  card: ClubCard | null;
  cards: AdminClubCard[];
  packages: TrainingPackage[];
  purchases: (Purchase & { decidedBy: string | null })[];
}

export interface MyPurchases {
  catalog: { clubCards: CatalogItem[]; services: CatalogItem[]; groupPasses: CatalogItem[] };
  card: ClubCard | null;
  // Latest card in any state, to say it burned / expired when there is no current one
  lastCard:
    | ({ label: string; activateBy: string } & (
        { state: "waiting" | "burned"; validUntil: null } | { state: "active" | "expired"; validUntil: string }
      ))
    | null;
  packages: TrainingPackage[];
  pending: Purchase | null;
  canPayCash: boolean; // only a member with a trainer
}

// until = last frozen day; null until the trainer approves
export interface MyFreeze {
  freeze:
    | ({ id: string } & (
        | { state: "requested"; startedOn: null; until: null }
        | { state: "active" | "unfreeze_requested"; startedOn: string; until: string }
      ))
    | null;
  canFreeze: boolean; // a card or trainings to freeze, and no open freeze
}

// until: last frozen day (for a pending freeze: if approved today)
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
  until: string | null; // last frozen day
  unfreezeRequested: boolean;
  decidedBy: string | null;
}

// Revenue of the trainer's paid purchases, by month paid
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
  weekdays: { weekday: number; days: number; avgPresent: number }[]; // weekday 1 = Mon … 7 = Sun
}

// The member's own cancellation or move, with their reason
export interface Cancellation {
  bookingId: string;
  displayName: string;
  reason: string;
  cancelledAt: string | null;
  switchedToTime: string | null; // null = cancelled, otherwise moved to that time
  // Late-cancellation fee: FULL = spent; HALF = spent, half a single training refunded
  fee: { kind: "FULL" | "HALF"; waived: boolean; refundUah: number | null; refundDone: boolean } | null;
}

// Fee if cancelled now (null = free); single = a single training rather than a pass
export interface CancelFeePreview {
  fee: "FULL" | "HALF" | null;
  single: boolean;
  refundUah: number | null;
}

// Half refund of a late-cancelled single assigned training; the trainer pays it out
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
  started?: boolean; // no booking, cancelling or switching after the start
  myGuest?: { name: string } | null;
  lateCancelled?: boolean; // cancelled late: can't book it again
}

// Personal / split slot the trainer assigned this member to
export interface AssignedSlotView {
  id: string;
  localDate: string;
  slotTime: string;
  trainingType: AssignedType;
  capacity: number;
  bookedCount: number;
  isMyBooking: boolean;
  spent: boolean; // paid from a package (attendance marked)
  packageLeft: number; // trainings left in usable packages of this type
  started: boolean;
}

// localDate null: no group training ahead (assigned ones may still be listed)
export interface ScheduleNext {
  localDate: string | null;
  status: string | null;
  bookingWindowOpen: boolean;
  bookingOpenAt: string | null;
  bookingCloseAt: string | null;
  slots: SlotView[]; // group slots of that day
  assignedSlots?: AssignedSlotView[];
  groupPassLeft: number; // 0 = booking offers to buy a group pass
  frozenUntil: string | null; // last frozen day; no booking while frozen
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
  switchedFromTime: string | null; // moved here from that time
  guestOf: string | null; // guest: the member's name; bookingId is then the guest's id
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
  // Assigned slots only. booked false = cancelled; spent = paid from a package
  members: { id: string; displayName: string; booked: boolean; spent: boolean; packageLeft: number }[];
}
