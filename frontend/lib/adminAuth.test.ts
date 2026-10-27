import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, statusOf } from "./api";
import { toAdminLogin } from "./adminAuth";

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a failed call", () => {
  it("throws ApiError with the backend's message, the status and the body", async () => {
    answer(409, { message: "Price changed", amountUah: 900, updatedBy: "demo" });
    const err = await api.updatePrice("p1", 1000, 800).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).message).toBe("Price changed");
    expect(statusOf(err)).toBe(409);
    expect((err as ApiError).body).toEqual({ message: "Price changed", amountUah: 900, updatedBy: "demo" });
  });

  it("has the status text when the body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500, statusText: "Server Error" })),
    );
    const err = await api.getStats().catch((e: unknown) => e);
    expect((err as ApiError).message).toBe("Server Error");
    expect(statusOf(err)).toBe(500);
  });

  it("no status without an answer (no connection)", () => {
    expect(statusOf(new TypeError("Failed to fetch"))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
  });
});

describe("toAdminLogin", () => {
  it.each([401, 403])("sends %i to the trainer login", (status) => {
    const router = { push: vi.fn() };
    expect(toAdminLogin(new ApiError("x", status, {}), router)).toBe(true);
    expect(router.push).toHaveBeenCalledWith("/admin/login");
  });

  it.each([400, 404, 409, 500])("leaves %i to the page", (status) => {
    const router = { push: vi.fn() };
    expect(toAdminLogin(new ApiError("x", status, {}), router)).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("leaves a network failure to the page", () => {
    const router = { push: vi.fn() };
    expect(toAdminLogin(new TypeError("Failed to fetch"), router)).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });
});
