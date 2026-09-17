import type { Severity } from "@shared/schemas";

/*
 * Status colours are reserved for state and always ship with an icon AND a label, so
 * severity is never carried by colour alone — which matters here because the light-mode
 * warning step sits below 3:1 against the surface by design.
 */
const STATUS: Record<Severity, { color: string; icon: string }> = {
  INFO: { color: "var(--status-good)", icon: "●" },
  WARN: { color: "var(--status-warning)", icon: "▲" },
  CRITICAL: { color: "var(--status-critical)", icon: "■" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { color, icon } = STATUS[severity];
  return (
    <span className="badge">
      <span className="icon" style={{ color }} aria-hidden>
        {icon}
      </span>
      {severity}
    </span>
  );
}

export function UrgencyBadge({ urgency }: { urgency: number }) {
  const color =
    urgency >= 5
      ? "var(--status-critical)"
      : urgency >= 4
        ? "var(--status-serious)"
        : urgency >= 3
          ? "var(--status-warning)"
          : "var(--status-good)";
  return (
    <span className="badge">
      <span className="dot" style={{ background: color }} aria-hidden />
      urgency {urgency}
    </span>
  );
}
