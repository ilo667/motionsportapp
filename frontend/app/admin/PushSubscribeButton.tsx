"use client";
import { useState, useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { ensurePushSubscribed, syncSubscription } from "@/lib/pushUtils";
import { noopSubscribe } from "@/lib/clientStore";

type Support = "pending" | "unsupported" | "denied" | "available";

// Whether this browser can do push at all; "pending" on the server and during hydration
function readSupport(): Support {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "available";
}

export function PushSubscribeButton() {
  const support = useSyncExternalStore<Support>(noopSubscribe, readSupport, () => "pending");
  // null = still checking the browser's current subscription, or a request is in flight
  const [subscribed, setSubscribed] = useState<boolean | null>(null);

  useEffect(() => {
    if (support !== "available") return;
    navigator.serviceWorker.ready
      .then(async (reg) => {
        const existing = await reg.pushManager.getSubscription();
        // Keep the server in sync for the current role (same browser may have subscribed as the other one)
        // Best effort on load: if it fails, the button still offers to subscribe
        if (existing) syncSubscription(existing).catch(() => {});
        setSubscribed(!!existing);
      })
      .catch(() => setSubscribed(false));
  }, [support]);

  const subscribe = async () => {
    setSubscribed(null);
    try {
      setSubscribed(await ensurePushSubscribed());
    } catch {
      setSubscribed(false);
    }
  };

  const unsubscribe = async () => {
    setSubscribed(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch {
      setSubscribed(true);
    }
  };

  // Permission can be refused in the prompt: hide the button like an already-denied browser
  if (support !== "available" || subscribed === null) return null;
  if (typeof Notification !== "undefined" && Notification.permission === "denied") return null;

  if (subscribed) {
    return (
      <button
        type="button"
        onClick={unsubscribe}
        className="flex items-center text-xs text-muted hover:text-body transition-colors"
        title="Вимкнути сповіщення"
      >
        <span className="mr-1.5">🔔</span>
        Сповіщення увімкнено
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={subscribe}
      className="flex items-center text-xs text-accent hover:underline transition-colors"
      title="Увімкнути push-сповіщення"
    >
      <span className="mr-1.5">🔕</span>
      Увімкнути сповіщення
    </button>
  );
}
