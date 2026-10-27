import { statusOf } from "./api";

// An admin page's call failed because nobody is signed in (401) or a member is (403): off to the trainer login.
// True when it went there, so the page shows its own error only otherwise
export function toAdminLogin(err: unknown, router: { push: (href: string) => void }): boolean {
  const status = statusOf(err);
  if (status !== 401 && status !== 403) return false;
  router.push("/admin/login");
  return true;
}
