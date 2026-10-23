import type { ReactNode } from "react";
import type { PriceListItem, PriceSection } from "@/lib/api";

// The gym's price list as the trainer («Ціни» in the admin) and clients (/prices) see it: sections, then each
// title with its options. The admin page passes `renderOption` to make prices editable

const SECTIONS: { key: PriceSection; title: string; note?: string }[] = [
  { key: "club_card", title: "Клубні карти" },
  { key: "assigned", title: "Послуги тренера", note: "Ціна без урахування вартості клубної карти" },
  { key: "group", title: "Групові заняття" },
];

export const formatPrice = (v: number) => `${v.toLocaleString("uk-UA")} ₴`;

// Options of one section grouped under their title ("Повний день": 1 / 3 / 6 місяців), in page order
function groupByTitle<T extends PriceListItem>(items: T[]) {
  const groups: { title: string; options: T[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last?.title === item.title) last.options.push(item);
    else groups.push({ title: item.title, options: [item] });
  }
  return groups;
}

function ReadOnlyOption({ item }: { item: PriceListItem }) {
  return (
    <div className="flex items-center justify-between space-x-3 py-0.5">
      <span className="text-body">{item.optionLabel}</span>
      <span className="font-geologica text-heading tabular-nums whitespace-nowrap">{formatPrice(item.amountUah)}</span>
    </div>
  );
}

export function PriceList<T extends PriceListItem>({
  items,
  renderOption,
}: {
  items: T[];
  renderOption?: (item: T) => ReactNode;
}) {
  return (
    <div className="flex flex-col space-y-8">
      {SECTIONS.map((section) => {
        const groups = groupByTitle(items.filter((i) => i.section === section.key));
        if (groups.length === 0) return null;
        return (
          <section key={section.key}>
            <h2 className="font-geologica font-semibold text-heading uppercase mb-1">{section.title}</h2>
            {section.note && <p className="text-muted text-xs mb-2">{section.note}</p>}
            <div className="border-t border-line">
              {groups.map((group) => (
                <div key={group.title} className="py-3 border-b border-line">
                  <div className="text-heading font-medium mb-1">{group.title}</div>
                  {group.options.map((item) =>
                    renderOption ? (
                      <div key={item.id}>{renderOption(item)}</div>
                    ) : (
                      <ReadOnlyOption key={item.id} item={item} />
                    ),
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
