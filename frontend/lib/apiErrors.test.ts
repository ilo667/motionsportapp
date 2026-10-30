import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { DEFAULT_ERROR, ERROR_TEXT, errorText } from "@/lib/apiErrors";

// What lib/api.ts throws for an error with a code: the backend's English message and the body { code, message }
const coded = (code: string, message = "English text") => new ApiError(message, 409, { code, message });

describe("errorText", () => {
  it("shows the text for the code", () => {
    expect(errorText(coded("SLOT_FULL"))).toBe("Місць вже немає, хтось встиг раніше");
    expect(errorText(coded("CANCELLED_LATE"))).toBe("Ви скасували це тренування пізно, записатися знову не можна");
  });

  it("goes by the code, not the English message: a reworded message changes nothing", () => {
    expect(errorText(coded("GROUP_GAP", "Keep group trainings 60 minutes apart"))).toBe(
      "Між груповими має бути щонайменше година",
    );
    expect(errorText(coded("SLOT_FULL", "Target slot is full"))).toBe("Місць вже немає, хтось встиг раніше");
  });

  it("never shows the backend's English: no code or an unknown one gets the fallback", () => {
    expect(errorText(new ApiError("Member not found", 404, { message: "Member not found" }))).toBe(DEFAULT_ERROR);
    expect(errorText(coded("SOMETHING_NEW"), "Помилка входу.")).toBe("Помилка входу.");
    expect(errorText(coded("constructor"))).toBe(DEFAULT_ERROR);
  });

  it("a network failure or something that is not an ApiError gets the fallback", () => {
    expect(errorText(new TypeError("Failed to fetch"))).toBe(DEFAULT_ERROR);
    expect(errorText(new Error("Slot is full"))).toBe(DEFAULT_ERROR);
    expect(errorText("boom")).toBe(DEFAULT_ERROR);
    expect(errorText(undefined, "Не вдалося зберегти.")).toBe("Не вдалося зберегти.");
  });

  it("a place can word the same error its own way", () => {
    const own = { MEMBER_FROZEN: "Клієнт заморожений: активуйте після розморозки" };
    expect(errorText(coded("MEMBER_FROZEN"), "Не вдалося", own)).toBe("Клієнт заморожений: активуйте після розморозки");
    expect(errorText(coded("MEMBER_FROZEN"))).toBe("Абонемент клієнта заморожено на цей день");
  });

  it("the unpaid purchase text keeps «Мій абонемент», which GroupPassModal turns into a link", () => {
    expect(errorText(coded("UNPAID_PURCHASE"))).toContain("Мій абонемент");
  });
});

// The two projects live in one repo: every code the backend can send has a text here, and nothing here is stale
describe("error codes match the backend", () => {
  const catalog = readFileSync(resolve(__dirname, "../../backend/src/common/api-error.ts"), "utf8");
  const backendCodes = [...catalog.matchAll(/^\s+([A-Z_]+): '/gm)].map((m) => m[1]).sort();

  it("the backend list is read", () => {
    expect(backendCodes.length).toBeGreaterThan(20);
  });

  it("the same codes on both sides", () => {
    expect(Object.keys(ERROR_TEXT).sort()).toEqual(backendCodes);
  });
});
