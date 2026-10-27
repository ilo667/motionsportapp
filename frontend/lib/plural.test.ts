import { describe, expect, it } from "vitest";
import { plural, trainingsCount } from "@/lib/plural";

describe("trainingsCount", () => {
  it.each([
    [1, "1 тренування"],
    [2, "2 тренування"],
    [4, "4 тренування"],
    [5, "5 тренувань"],
    [8, "8 тренувань"],
    [10, "10 тренувань"],
    [11, "11 тренувань"],
    [14, "14 тренувань"],
    [21, "21 тренування"],
    [22, "22 тренування"],
    [25, "25 тренувань"],
    [111, "111 тренувань"],
    [0, "0 тренувань"],
  ])("%i → %s", (n, text) => {
    expect(trainingsCount(n)).toBe(text);
  });
});

describe("plural", () => {
  const forms: [string, string, string] = ["персональне", "персональні", "персональних"];

  it("picks the form for 1, 2–4 and 5+", () => {
    expect(plural(1, forms)).toBe("1 персональне");
    expect(plural(3, forms)).toBe("3 персональні");
    expect(plural(8, forms)).toBe("8 персональних");
  });

  it("takes the 5+ form for 11–14, also past a hundred", () => {
    expect(plural(11, forms)).toBe("11 персональних");
    expect(plural(12, forms)).toBe("12 персональних");
    expect(plural(112, forms)).toBe("112 персональних");
    expect(plural(101, forms)).toBe("101 персональне");
  });
});
