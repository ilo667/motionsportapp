import { describe, expect, it } from "vitest";
import { formatUah, groupByTitle, lineName } from "@/lib/prices";

describe("prices", () => {
  it("formatUah groups thousands", () => {
    expect(formatUah(850)).toBe("850 ₴");
    expect(formatUah(1400).replace(/\s/g, " ")).toBe("1 400 ₴");
  });

  it("lineName: title and option, or the title alone", () => {
    expect(lineName({ title: "Повний день", optionLabel: "3 місяці" })).toBe("Повний день · 3 місяці");
    expect(lineName({ title: "Разове відвідування", optionLabel: null })).toBe("Разове відвідування");
  });

  it("groupByTitle keeps the order and joins only neighbours", () => {
    const items = [
      { title: "Повний день", id: 1 },
      { title: "Повний день", id: 2 },
      { title: "Ранок", id: 3 },
    ];
    expect(groupByTitle(items)).toEqual([
      { title: "Повний день", items: [items[0], items[1]] },
      { title: "Ранок", items: [items[2]] },
    ]);
  });
});
