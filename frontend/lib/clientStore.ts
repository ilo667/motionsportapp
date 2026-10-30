import { useSyncExternalStore } from "react";

// For browser-only values via useSyncExternalStore: server value during hydration, no setState in an effect
export const noopSubscribe = () => () => {};

export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
