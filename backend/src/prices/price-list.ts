// The gym's price list as of 2026-10-23. Used only by `npm run seed:prices` to fill an empty table;
// after that the amounts live in the DB and trainers change them on the «Ціни» page
export const PRICE_SECTIONS = ['club_card', 'assigned', 'group'] as const;
export type PriceSection = (typeof PRICE_SECTIONS)[number];

export type PriceListItem = {
  code: string;
  section: PriceSection;
  title: string;
  optionLabel: string | null;
  amountUah: number;
};

export const DEFAULT_PRICE_LIST: PriceListItem[] = [
  { code: 'club_single', section: 'club_card', title: 'Разове відвідування', optionLabel: null, amountUah: 250 },
  { code: 'club_full_1m', section: 'club_card', title: 'Повний день', optionLabel: '1 місяць', amountUah: 1400 },
  { code: 'club_full_3m', section: 'club_card', title: 'Повний день', optionLabel: '3 місяці', amountUah: 3400 },
  { code: 'club_full_6m', section: 'club_card', title: 'Повний день', optionLabel: '6 місяців', amountUah: 5800 },
  { code: 'club_day_1m', section: 'club_card', title: 'Денний', optionLabel: '1 місяць', amountUah: 1200 },
  { code: 'club_day_3m', section: 'club_card', title: 'Денний', optionLabel: '3 місяці', amountUah: 3000 },
  { code: 'club_day_6m', section: 'club_card', title: 'Денний', optionLabel: '6 місяців', amountUah: 5000 },
  { code: 'club_weekend_1m', section: 'club_card', title: 'Вт, Чт, Сб, Нд', optionLabel: '1 місяць', amountUah: 1200 },
  { code: 'club_weekend_3m', section: 'club_card', title: 'Вт, Чт, Сб, Нд', optionLabel: '3 місяці', amountUah: 3000 },
  { code: 'personal_1', section: 'assigned', title: 'Персональне', optionLabel: '1 тренування', amountUah: 600 },
  { code: 'personal_6', section: 'assigned', title: 'Персональне', optionLabel: '6 тренувань', amountUah: 2800 },
  { code: 'personal_8', section: 'assigned', title: 'Персональне', optionLabel: '8 тренувань', amountUah: 3600 },
  { code: 'personal_12', section: 'assigned', title: 'Персональне', optionLabel: '12 тренувань', amountUah: 5200 },
  { code: 'split_1', section: 'assigned', title: 'Спліт', optionLabel: '1 тренування', amountUah: 400 },
  { code: 'split_6', section: 'assigned', title: 'Спліт', optionLabel: '6 тренувань', amountUah: 2300 },
  { code: 'split_8', section: 'assigned', title: 'Спліт', optionLabel: '8 тренувань', amountUah: 2700 },
  { code: 'split_12', section: 'assigned', title: 'Спліт', optionLabel: '12 тренувань', amountUah: 3400 },
  { code: 'group_single', section: 'group', title: 'Разове відвідування', optionLabel: null, amountUah: 250 },
  { code: 'group_10', section: 'group', title: 'Абонемент', optionLabel: '10 занять', amountUah: 2200 },
];
