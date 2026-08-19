const STEPS = ["Upload", "Select Frame", "Edit", "Export"];

export default function Stepper({ current }: { current: number }) {
  return (
    <div className="stepper">
      {STEPS.map((label, i) => (
        <div key={label} className={`step-chip ${i === current ? "active" : ""} ${i < current ? "done" : ""}`}>
          {i + 1}. {label}
        </div>
      ))}
    </div>
  );
}
