// What the backend answers (and takes): the types of lib/api.ts, imported from there

export type TrainingType = "group" | "personal" | "split";

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

// Dates exist only from activation, so the types say which states have them: after a check of `state` TypeScript
// knows the date is there (backend: cardState / passState in purchases/validity.ts). Dates are YYYY-MM-DD
type NotActivated = { validFrom: null; validUntil: null };
type Activated = { validFrom: string; validUntil: string };

// The card a member has now (waiting or active); activateBy = the last day to activate a waiting card
export type ClubCard = { id: string; label: string; activateBy: string } & (
  { state: "waiting"; validUntil: null } | { state: "active"; validUntil: string }
);

// A card on the client page: every state
export type AdminClubCard = { id: string; label: string; activateBy: string; source: "purchase" | "manual" } & (
  ({ state: "waiting" | "burned" } & NotActivated) | ({ state: "active" | "expired" } & Activated)
);

// The first attendance mark activates a pass; a used one was always activated (spending activates)
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
  cards: AdminClubCard[];
  packages: TrainingPackage[];
  purchases: (Purchase & { decidedBy: string | null })[];
}

export interface MyPurchases {
  catalog: { clubCards: CatalogItem[]; services: CatalogItem[]; groupPasses: CatalogItem[] };
  card: ClubCard | null;
  // The latest card with its state: shows «згоріла» / «закінчилась» when there is no card any more
  lastCard:
    | ({ label: string; activateBy: string } & (
        { state: "waiting" | "burned"; validUntil: null } | { state: "active" | "expired"; validUntil: string }
      ))
    | null;
  packages: TrainingPackage[];
  pending: Purchase | null;
  canPayCash: boolean; // cash goes to the member's trainer
}

// «Заморозити абонемент»: until = the last frozen day (null while the trainer hasn't approved)
export interface MyFreeze {
  freeze:
    | ({ id: string } & (
        | { state: "requested"; startedOn: null; until: null }
        | { state: "active" | "unfreeze_requested"; startedOn: string; until: string }
      ))
    | null;
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
