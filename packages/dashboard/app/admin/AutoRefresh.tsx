"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Re-renders the `/admin` server component on an interval via
 * `router.refresh()`, which re-runs the server fetch and streams a new RSC
 * payload in. Doing it this way keeps `ADMIN_TOKEN` where it belongs: the token
 * is read only inside the server component, and the browser never sees it or any
 * endpoint that would accept it.
 *
 * The "last refreshed" clock is set in an effect and starts as `null`, so the
 * server and the first client render agree and there is no hydration mismatch.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      router.refresh();
      setLastRefresh(new Date().toLocaleTimeString());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [paused, intervalMs, router]);

  return (
    <div className="toolbar">
      <span className={`text-sm ${paused ? "muted" : "ok"}`}>
        {paused ? "auto-refresh paused" : `auto-refreshing every ${Math.round(intervalMs / 1000)}s`}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
        {paused ? "resume" : "pause"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          router.refresh();
          setLastRefresh(new Date().toLocaleTimeString());
        }}
      >
        refresh now
      </Button>
      {lastRefresh && <span className="muted text-sm">last refresh {lastRefresh}</span>}
    </div>
  );
}
