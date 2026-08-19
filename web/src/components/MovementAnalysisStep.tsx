import { useEffect, useRef, useState } from "react";
import { analyzeMuscles, saveMuscles } from "../api/client";
import type { MuscleRole, MuscleSuggestion } from "../types";

const ROLES: MuscleRole[] = ["agonist", "synergist", "stabilizer"];

export default function MovementAnalysisStep({
  sessionId,
  exerciseName,
  onConfirmed,
}: {
  sessionId: string;
  exerciseName?: string;
  onConfirmed: (muscles: MuscleSuggestion[]) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [muscles, setMuscles] = useState<MuscleSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    analyzeMuscles(sessionId, exerciseName)
      .then((r) => setMuscles(r.muscles))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, exerciseName]);

  function update(id: string, patch: Partial<MuscleSuggestion>) {
    setMuscles((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch, source: "user" } : m)));
  }

  function remove(id: string) {
    setMuscles((prev) => prev.filter((m) => m.id !== id));
  }

  function add() {
    setMuscles((prev) => [
      ...prev,
      { id: `local_${Date.now()}`, name: "New Muscle", role: "synergist", anchor: { x: 0.5, y: 0.5 }, source: "user" },
    ]);
  }

  async function confirm() {
    setBusy(true);
    try {
      await saveMuscles(sessionId, muscles);
      onConfirmed(muscles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>5-6. Movement Analysis &amp; Select Primary Muscles</h2>
      <p className="muted">
        OpenAI's kinesiological/biomechanical analysis suggests agonist, synergist and stabilizer muscles for this
        position. You stay in control: approve, remove, add, or replace any entry before continuing.
      </p>

      {loading && (
        <div className="spinner-line">
          <span className="dot" /> Running kinesiological analysis…
        </div>
      )}

      {!loading && (
        <div className="muscle-list">
          {muscles.map((m) => (
            <div className="muscle-row" key={m.id}>
              <input type="text" value={m.name} onChange={(e) => update(m.id, { name: e.target.value })} style={{ flex: 1 }} />
              <select value={m.role} onChange={(e) => update(m.id, { role: e.target.value as MuscleRole })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <span className={`role-badge`}>{m.source === "ai" ? "AI" : "edited"}</span>
              <button className="secondary" onClick={() => remove(m.id)}>
                Remove
              </button>
            </div>
          ))}
          {muscles.length === 0 && <p className="muted">No muscles selected. Add at least one to continue.</p>}
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={add} disabled={loading}>
          + Add Muscle
        </button>
        <button onClick={confirm} disabled={loading || busy || muscles.length === 0}>
          Confirm Selection
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
