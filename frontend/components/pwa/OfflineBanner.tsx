"use client";
import { useEffect, useState, useSyncExternalStore } from "react";

// Short drops (Wi-Fi → mobile) shouldn't flash the strip
const SHOW_AFTER_MS = 5_000;

// 0 = online; each disconnect gets a new number, so the delay restarts
let offlineEpisode = 0;
let episodeCounter = 0;
let initialized = false;

function getSnapshot() {
  if (!initialized) {
    initialized = true;
    if (!navigator.onLine) offlineEpisode = ++episodeCounter;
  }
  return offlineEpisode;
}

function subscribe(onChange: () => void) {
  const goOffline = () => {
    offlineEpisode = ++episodeCounter;
    onChange();
  };
  const goOnline = () => {
    offlineEpisode = 0;
    onChange();
  };
  window.addEventListener("offline", goOffline);
  window.addEventListener("online", goOnline);
  return () => {
    window.removeEventListener("offline", goOffline);
    window.removeEventListener("online", goOnline);
  };
}

// Server render assumes online
export function OfflineBanner() {
  const episode = useSyncExternalStore(subscribe, getSnapshot, () => 0);
  const [shownEpisode, setShownEpisode] = useState(0);

  useEffect(() => {
    if (!episode) return;
    const timer = setTimeout(() => setShownEpisode(episode), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [episode]);

  if (!episode || shownEpisode !== episode) return null;

  return (
    <div role="status" className="sticky top-0 z-50 bg-danger text-on-teal text-sm font-medium text-center px-5 py-2">
      Немає інтернету. Дані можуть бути застарілими
    </div>
  );
}
