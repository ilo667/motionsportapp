import { api } from "./api";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Registers the browser's subscription for whoever is signed in (member or trainer); the server upserts by endpoint
export async function syncSubscription(sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
  await api.subscribePush({ endpoint: json.endpoint, p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" });
}

// On page load: if this browser is already subscribed, register it for whoever is signed in now
// (after logout the server switched it off; signing in again turns pushes back on without a new prompt)
export async function resyncExistingSubscription() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const existing = await reg?.pushManager?.getSubscription();
    if (existing) await syncSubscription(existing);
  } catch {
    // no push support or offline: nothing to sync
  }
}

export async function ensurePushSubscribed(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (Notification.permission === "denied") return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    // The browser may be subscribed under the other role (trainer testing as a member), so register it again
    if (existing) {
      await syncSubscription(existing);
      return true;
    }

    const { publicKey } = await api.getVapidPublicKey();
    if (!publicKey) return false;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    });

    await syncSubscription(sub);
    return true;
  } catch {
    return false;
  }
}
