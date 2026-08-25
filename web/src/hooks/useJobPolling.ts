import { useCallback, useRef, useState } from "react";
import type { ExportJobStatus } from "../api/client";

// Tolerates a long run of transient failures before giving up — a failed
// poll (e.g. a platform proxy returning 502 while a CPU-bound ffmpeg
// encode is starving the single shared CPU core the Node process needs to
// even answer a trivial status request) shouldn't make the UI abandon a
// job that's actually still running fine server-side. A real ffmpeg
// encode of a real video can plausibly cause this kind of contention for
// tens of seconds at a time on a single-vCPU instance, so this is
// deliberately generous (~48s at the default 800ms interval) rather than
// tuned to what a tiny synthetic test video needs.
const MAX_CONSECUTIVE_FAILURES = 60;

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
