"use client";
import { useEffect } from "react";

export function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // Without a service worker the app still works; only offline and push are missing
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
