"use client";
import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { ensurePushSubscribed, syncSubscription } from "@/lib/pushUtils";

type PushState = "unsupported" | "loading" | "denied" | "subscribed" | "unsubscribed";

export function PushSubscribeButton() {
  const [state, setState] = useState<PushState>("loading");

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    navigator.serviceWorker.ready.then(async (reg) => {
      const existing = await reg.pushManager.getSubscription();
      // Keep the server in sync for the current role (same browser may have subscribed as the other one)
      if (existing) syncSubscription(existing).catch(() => {});
      setState(existing ? "subscribed" : "unsubscribed");
    }).catch(() => setState("unsubscribed"));
  }, []);

  const subscribe = async () => {
    setState("loading");
    try {
      const ok = await ensurePushSubscribed();
      if (ok) setState("subscribed");
      else if (Notification.permission === "denied") setState("denied");
      else setState("unsubscribed");
    } catch {
      setState("unsubscribed");
    }
  };

  const unsubscribe = async () => {
    setState("loading");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setState("unsubscribed");
    } catch {
      setState("subscribed");
    }
  };

  if (state === "unsupported" || state === "denied") return null;
  if (state === "loading") return null;

  if (state === "subscribed") {
    return (
      <button
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
      onClick={subscribe}
      className="flex items-center text-xs text-accent hover:underline transition-colors"
      title="Увімкнути push-сповіщення"
    >
      <span className="mr-1.5">🔕</span>
      Увімкнути сповіщення
    </button>
  );
}