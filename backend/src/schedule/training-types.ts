import { DateTime } from 'luxon';

export const KY_ZONE = 'Europe/Kyiv';

// Training types as stored in the DB and sent by the API (UI words: групові, персональні, спліт; the frontend maps them)
export const GROUP_TYPE = 'group';
export const GROUP_CAPACITY = 8;
// Assigned slots: visible only to members listed in slot_members, paid via LiqPay, bookable until the start
export const ASSIGNED_TYPES = ['personal', 'split'];
// What a package can pay for: trainer services and group passes
export const PASS_TYPES = [GROUP_TYPE, ...ASSIGNED_TYPES];
// Members an assigned slot is assigned to: personal exactly 1, split 1–3.
// Capacity is always `max` (personal 1, split 3), however many members are assigned
export const ASSIGNED_MEMBER_LIMITS: Record<string, { min: number; max: number }> = {
  personal: { min: 1, max: 1 },
  split: { min: 1, max: 3 },
};

export function isAssignedType(trainingType: string) {
  return ASSIGNED_TYPES.includes(trainingType);
}

export function slotStartsAt(localDate: string, slotTime: string) {
  return DateTime.fromISO(`${localDate}T${slotTime}:00`, { zone: KY_ZONE });
}

// A training is over an hour after its start: the 22:00 cron marks it then, and disabling a trainer leaves it as it is
export function slotOverAt(localDate: string, slotTime: string) {
  return slotStartsAt(localDate, slotTime).plus({ hours: 1 });
}
