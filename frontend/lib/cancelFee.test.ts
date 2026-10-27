import { describe, expect, it } from "vitest";
import { feeLabel, feeWarning } from "@/lib/cancelFee";

describe("feeWarning (the member's «Скасувати»)", () => {
  it("says nothing when cancelling is free or the preview hasn't come", () => {
    expect(feeWarning(null)).toBeNull();
    expect(feeWarning({ fee: null, single: false, refundUah: null })).toBeNull();
  });

  it("a single training under 2 hours burns, no money back", () => {
    expect(feeWarning({ fee: "FULL", single: true, refundUah: null })).toBe(
      "Тренування згорить, гроші не повертаються.",
    );
  });

  it("a pass loses one training", () => {
    expect(feeWarning({ fee: "FULL", single: false, refundUah: null })).toBe("З абонемента спишеться 1 тренування.");
  });

  it("a single personal training 2–24 hours ahead gets half back, with the sum when known", () => {
    expect(feeWarning({ fee: "HALF", single: true, refundUah: 300 })).toBe(
      "Тренування згорить, повернемо 50% (300 ₴).",
    );
    expect(feeWarning({ fee: "HALF", single: true, refundUah: null })).toBe("Тренування згорить, повернемо 50%.");
  });
});

describe("feeLabel (the trainer's «Скасували»)", () => {
  const fee = { kind: "FULL" as const, waived: false, refundUah: null, refundDone: false };

  it("a spent training", () => {
    expect(feeLabel(fee)).toBe("списано");
  });

  it("half to return, then returned", () => {
    expect(feeLabel({ ...fee, kind: "HALF", refundUah: 300 })).toBe("повернути 300 ₴");
    expect(feeLabel({ ...fee, kind: "HALF", refundUah: 300, refundDone: true })).toBe("повернено 300 ₴");
  });

  it("half without a sum reads as spent", () => {
    expect(feeLabel({ ...fee, kind: "HALF" })).toBe("списано");
  });

  it("«Не списувати» wins over everything", () => {
    expect(feeLabel({ ...fee, waived: true })).toBe("не списано");
    expect(feeLabel({ ...fee, kind: "HALF", refundUah: 300, waived: true })).toBe("не списано");
  });
});
