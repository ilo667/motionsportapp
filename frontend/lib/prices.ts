// «1 400 ₴»
export const formatUah = (v: number) => `${v.toLocaleString("uk-UA")} ₴`;

// «Повний день · 3 місяці», or just the title when it has one option
export const lineName = (l: { title: string; optionLabel: string | null }) =>
  l.optionLabel ? `${l.title} · ${l.optionLabel}` : l.title;

// Options grouped under their title ("Повний день": 1 / 3 / 6 місяців), in price list order
export function groupByTitle<T extends { title: string }>(items: T[]) {
  const groups: { title: string; items: T[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last?.title === item.title) last.items.push(item);
    else groups.push({ title: item.title, items: [item] });
  }
  return groups;
}
