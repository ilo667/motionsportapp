import type { ReactNode } from "react";
import type { PriceListItem, PriceSection } from "@/lib/api";
import { formatUah, groupByTitle } from "@/lib/prices";

// The gym's price list as the trainer («Ціни» in the admin) and clients (/prices) see it: sections, then each
// title with its options. The admin page passes `renderOption` to make prices editable

const SECTIONS: { key: PriceSection; title: string; note?: string }[] = [
  { key: "club_card", title: "Клубні карти" },
  { key: "assigned", title: "Послуги тренера", note: "Ціна без урахування вартості клубної карти" },
  { key: "group", title: "Групові заняття" },
];

function ReadOnlyOption({ item }: { item: PriceListItem }) {
  return (
    <div className="flex items-center justify-between space-x-3 py-0.5">
      <span className="text-body">{item.optionLabel}</span>
      <span className="font-geologica text-heading tabular-nums whitespace-nowrap">{formatUah(item.amountUah)}</span>
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
              {groups.map((group) => {
                const option = (item: T) =>
                  renderOption ? (
                    <div key={item.id}>{renderOption(item)}</div>
                  ) : (
                    <ReadOnlyOption key={item.id} item={item} />
                  );
                // One price with no option («Разове відвідування»): the title and the price on one line
                const single = group.items.length === 1 && !group.items[0].optionLabel;
                return single ? (
                  <div key={group.title} className="py-3 border-b border-line flex items-center space-x-3">
                    <div className="text-heading font-medium">{group.title}</div>
                    <div className="flex-1 min-w-0">{option(group.items[0])}</div>
                  </div>
                ) : (
                  <div key={group.title} className="py-3 border-b border-line">
                    <div className="text-heading font-medium mb-1">{group.title}</div>
                    {group.items.map(option)}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
