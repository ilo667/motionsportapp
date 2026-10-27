import { describe, expect, it } from "vitest";
import { DEFAULT_ERROR, errorText } from "@/lib/apiErrors";

// What lib/api.ts throws: the backend's message in an Error
const apiError = (message: string) => Object.assign(new Error(message), { status: 409 });

describe("errorText", () => {
  it("translates a backend message", () => {
    expect(errorText(apiError("Slot is full"))).toBe("Місць вже немає, хтось встиг раніше");
    expect(errorText(apiError("Cancelled late"))).toBe("Ви скасували це тренування пізно, записатися знову не можна");
  });

  it("matches a part of the message (the rules add details)", () => {
    expect(errorText(apiError("Group trainings must be at least an hour apart"))).toBe(
      "Між груповими має бути щонайменше година",
    );
    expect(errorText(apiError("Time must be in 15-minute steps"))).toBe("Вкажіть час з кроком 15 хвилин");
  });

  it("a longer message wins over a shorter one inside it", () => {
    expect(errorText(apiError("Target slot is cancelled"))).toBe("Цей час скасовано тренером");
    expect(errorText(apiError("Slot is no longer available"))).toBe("Цього тренування вже немає в розкладі");
  });

  it("never shows the backend's English: an unknown message gets the fallback", () => {
    expect(errorText(apiError("Member not found"))).toBe(DEFAULT_ERROR);
    expect(errorText(apiError("Internal Server Error"), "Помилка входу.")).toBe("Помилка входу.");
  });

  it("a network failure or something that is not an Error gets the fallback", () => {
    expect(errorText(new TypeError("Failed to fetch"))).toBe(DEFAULT_ERROR);
    expect(errorText("boom")).toBe(DEFAULT_ERROR);
    expect(errorText(undefined, "Не вдалося зберегти.")).toBe("Не вдалося зберегти.");
  });

  it("a place can word the same error its own way", () => {
    const own: [string, string][] = [["Member is frozen", "Клієнт заморожений: активуйте після розморозки"]];
    expect(errorText(apiError("Member is frozen"), "Не вдалося", own)).toBe(
      "Клієнт заморожений: активуйте після розморозки",
    );
    expect(errorText(apiError("Member is frozen"))).toBe("Абонемент клієнта заморожено на цей день");
  });

  it("the unpaid purchase text keeps «Мій абонемент», which GroupPassModal turns into a link", () => {
    expect(errorText(apiError("You have an unpaid purchase"))).toContain("Мій абонемент");
  });
});
