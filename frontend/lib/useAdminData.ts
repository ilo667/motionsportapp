"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toAdminLogin } from "@/lib/adminAuth";

// 401 / 403 goes to /admin/login. reload() keeps the old data on failure: error without data = didn't load,
// with data = couldn't refresh. `fetcher` must be stable (module function, api.* method or useCallback).
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
