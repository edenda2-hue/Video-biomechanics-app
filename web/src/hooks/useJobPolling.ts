import { useCallback, useRef, useState } from "react";
import type { ExportJobStatus } from "../api/client";

// Tolerates a run of transient failures before giving up — a single failed
// poll (e.g. a platform proxy briefly returning 502 while the server's
// event loop is busy compositing a large frame) shouldn't make the UI
// abandon a job that's actually still running fine server-side.
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Shared polling logic for the three export flows (single-freeze,
 * continuous, keyframes) — all poll the same {phase,percent,message,...}
 * job-status shape. `start`/`stop` are wrapped in useCallback so their
 * identity stays stable across re-renders — every status update calls
 * setStatus, which re-renders the owning component; an unmemoized `stop`
 * passed as a `useEffect` dependency there would get a new identity each
 * render, making that effect's cleanup fire (and clearInterval) after
 * every single tick instead of only on unmount.
 */
export function useJobPolling(fetchStatus: (sessionId: string) => Promise<ExportJobStatus>) {
  const [status, setStatus] = useState<ExportJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failuresRef = useRef(0);

  const stop = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const start = useCallback(
    (sessionId: string, intervalMs = 800) => {
      stop();
      failuresRef.current = 0;
      pollRef.current = setInterval(async () => {
        try {
          const s = await fetchStatus(sessionId);
          failuresRef.current = 0;
          setStatus(s);
          if (s.phase === "done" || s.phase === "error") stop();
        } catch (e) {
          failuresRef.current += 1;
          if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
            stop();
            setError(e instanceof Error ? e.message : String(e));
          }
          // else: keep polling silently — likely a transient gateway blip, not the job actually failing.
        }
      }, intervalMs);
    },
    [fetchStatus, stop],
  );

  return { status, setStatus, error, setError, start, stop };
}
