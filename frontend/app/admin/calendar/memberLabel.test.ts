import { describe, expect, it } from "vitest";
import { memberLabel } from "./memberLabel";

describe("memberLabel (a member in the calendar modal)", () => {
  it("cancelled wins, whatever was paid", () => {
    expect(memberLabel({ booked: false, spent: true, packageLeft: 5 })).toEqual({
      text: "скасовано",
      className: "text-muted",
    });
  });

  it("paid once the training is spent from a pass", () => {
    expect(memberLabel({ booked: true, spent: true, packageLeft: 3 }).text).toBe("оплачено");
  });

  it("trainings left to pay it, not «оплачено»", () => {
    expect(memberLabel({ booked: true, spent: false, packageLeft: 6 })).toEqual({
      text: "залишилось 6 тренувань",
      className: "text-teal",
    });
    expect(memberLabel({ booked: true, spent: false, packageLeft: 1 }).text).toBe("залишилось 1 тренування");
  });

  it("nothing to pay with", () => {
    expect(memberLabel({ booked: true, spent: false, packageLeft: 0 })).toEqual({
      text: "не оплачено",
      className: "text-muted",
    });
  });
});
