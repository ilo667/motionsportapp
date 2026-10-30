"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toAdminLogin } from "@/lib/adminAuth";

// One admin page's data: loaded on mount; signed out (401 / 403) goes to /admin/login, any other failure is kept in
// `error` for the page to show. `reload()` refetches after a change and keeps the old data if it fails, so a page
// tells «didn't load» (no data) from «couldn't refresh» (data and an error). `fetcher` must be stable: a function
// defined outside the component, an `api.*` method, or a useCallback
export function useAdminData<T>(fetcher: () => Promise<T>) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    try {
      const next = await fetcher();
      setData(next);
      setError(null);
    } catch (err: unknown) {
      if (!toAdminLogin(err, router)) setError(err);
    }
  }, [fetcher, router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reload is async: state is set after the await, not synchronously
    reload();
  }, [reload]);

  return { data, setData, error, reload };
}
