import { DateTime } from 'luxon';

export const KY_ZONE = 'Europe/Kyiv';

export const GROUP_TYPE = 'групові';
// Assigned slots: visible only to members listed in slot_members, paid via LiqPay, bookable until the start
export const ASSIGNED_TYPES = ['персональні', 'спліт'];
// What a package can pay for: trainer services and group passes
export const PASS_TYPES = [GROUP_TYPE, ...ASSIGNED_TYPES];
// Members an assigned slot is assigned to: персональні exactly 1, спліт 1–3.
// Capacity is always `max` (персональні 1, спліт 3), however many members are assigned
export const ASSIGNED_MEMBER_LIMITS: Record<string, { min: number; max: number }> = {
  персональні: { min: 1, max: 1 },
  спліт: { min: 1, max: 3 },
};

export function isAssignedType(trainingType: string) {
  return ASSIGNED_TYPES.includes(trainingType);
}

export function slotStartsAt(localDate: string, slotTime: string) {
  return DateTime.fromISO(`${localDate}T${slotTime}:00`, { zone: KY_ZONE });
}
