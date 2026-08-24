const DEFAULT_STEPS = ["Upload", "Select Frame", "Edit", "Export"];

export default function Stepper({ current, labels = DEFAULT_STEPS }: { current: number; labels?: string[] }) {
  return (
    <div className="stepper">
      {labels.map((label, i) => (
        <div key={label} className={`step-chip ${i === current ? "active" : ""} ${i < current ? "done" : ""}`}>
          {i + 1}. {label}
        </div>
      ))}
    </div>
  );
}
