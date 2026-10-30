import { DateTime } from 'luxon';

export const KY_ZONE = 'Europe/Kyiv';

// DB / API values; only the frontend turns them into words
export const GROUP_TYPE = 'group';
export const GROUP_CAPACITY = 8;
// Assigned slots: the trainer picks the members (slot_members); only they see the slot
export const ASSIGNED_TYPES = ['personal', 'split'];
export const PASS_TYPES = [GROUP_TYPE, ...ASSIGNED_TYPES];
// Capacity is always `max`, however many members are assigned
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

// Used by the auto-attendance cron and by trainer disabling (an over training is left as is)
export function slotOverAt(localDate: string, slotTime: string) {
  return slotStartsAt(localDate, slotTime).plus({ hours: 1 });
}
