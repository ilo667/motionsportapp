import { DateTime } from 'luxon';

export const KY_ZONE = 'Europe/Kyiv';

export type TrainingType = 'групові' | 'індивідуальні' | 'спліт';

export const GROUP_TYPE = 'групові';
// Personal slots: visible only to members listed in slot_members, paid via LiqPay, bookable until the start
export const PERSONAL_TYPES = ['індивідуальні', 'спліт'];
export const GROUP_SLOT_TIMES = ['19:00', '20:00'];
// Members a personal slot is assigned to: індивідуальні exactly 1, спліт 1–3
export const PERSONAL_MEMBER_LIMITS: Record<string, { min: number; max: number }> = {
  індивідуальні: { min: 1, max: 1 },
  спліт: { min: 1, max: 3 },
};

export function isPersonalType(trainingType: string) {
  return PERSONAL_TYPES.includes(trainingType);
}

export function slotStartsAt(localDate: string, slotTime: string) {
  return DateTime.fromISO(`${localDate}T${slotTime}:00`, { zone: KY_ZONE });
}
