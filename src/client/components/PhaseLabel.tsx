// src/client/components/PhaseLabel.tsx

const PHASE_LABELS: Record<string, string> = {
  "greeting":           "Welcome",
  "product-discovery":  "Finding your product",
  "product-detail":     "Product details",
  "comparison":         "Comparing",
  "wrapup":             "Recommendation",
  "done":               "Session complete",
};

interface Props { phase: string; }

export function PhaseLabel({ phase }: Props) {
  const label = PHASE_LABELS[phase] ?? phase;
  return (
    <div className="phase-label">
      <span className="phase-dot" aria-hidden="true" />
      {label}
    </div>
  );
}
