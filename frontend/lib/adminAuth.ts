import { statusOf } from "./api";

// 401 / 403 → trainer login; returns true if it redirected
export function toAdminLogin(err: unknown, router: { push: (href: string) => void }): boolean {
  const status = statusOf(err);
  if (status !== 401 && status !== 403) return false;
  router.push("/admin/login");
  return true;
}
