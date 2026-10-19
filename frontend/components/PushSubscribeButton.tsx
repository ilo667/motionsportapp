"use client";
import { useState, useEffect } from "react";
import { api } from "@/lib/api";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

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
      setState(existing ? "subscribed" : "unsubscribed");
    }).catch(() => setState("unsubscribed"));
  }, []);

  const subscribe = async () => {
    setState("loading");
    try {
      const { publicKey } = await api.getVapidPublicKey();
      if (!publicKey) { setState("unsupported"); return; }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      const json = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
      await api.subscribePush({
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
      });
      setState("subscribed");
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "NotAllowedError") setState("denied");
      else setState("unsubscribed");
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