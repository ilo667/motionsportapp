import { useSyncExternalStore } from "react";

// Browser-only values (localStorage, navigator) read as an external store: the server render and
// hydration use the server value, then React switches to the browser one with no setState in an effect
export const noopSubscribe = () => () => {};

export function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
