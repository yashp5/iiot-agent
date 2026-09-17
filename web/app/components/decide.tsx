"use client";

import { useState } from "react";
import { DECISION_ACTIONS, type DecisionAction } from "@shared/schemas";

/*
 * The human in the loop. The agent proposes; a person decides; the decision goes on chain
 * signed by an operator key the agent does not hold.
 */

const LABEL: Record<DecisionAction, string> = {
  ACKNOWLEDGE: "Acknowledge",
  ESCALATE: "Escalate",
  REQUEST_SHUTDOWN: "Request shutdown",
  FALSE_POSITIVE: "False positive",
};

/** Actions a slip of the finger should not complete. */
const CONFIRM: Partial<Record<DecisionAction, string>> = {
  REQUEST_SHUTDOWN: "Publish a shutdown request for this boiler?",
  FALSE_POSITIVE: "Mark this report a false positive? It quiets reporting for 30 minutes.",
};

export function DecisionBar({
  reportId,
  boiler,
  decided,
}: {
  reportId: string;
  boiler: string;
  decided?: { action: DecisionAction; operator: string; note?: string };
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<DecisionAction | undefined>();
  const [result, setResult] = useState<string | undefined>();

  const submit = async (action: DecisionAction) => {
    const question = CONFIRM[action];
    if (question && !window.confirm(question)) return;

    setBusy(action);
    setResult(undefined);
    try {
      const response = await fetch("/api/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportId, b: boiler, action, note }),
      });
      const body = (await response.json()) as { sequenceNumber?: number; error?: string };
      setResult(
        body.error
          ? `failed: ${body.error}`
          : `published to the decisions topic as message ${body.sequenceNumber}`,
      );
      if (!body.error) setNote("");
    } catch (error) {
      setResult(`failed: ${error instanceof Error ? error.message : "request failed"}`);
    } finally {
      setBusy(undefined);
    }
  };

  if (decided) {
    return (
      <p className="decided">
        <strong>{LABEL[decided.action]}</strong> by {decided.operator}
        {decided.note ? ` — ${decided.note}` : ""}
      </p>
    );
  }

  return (
    <div className="decide">
      <input
        value={note}
        onChange={(event) => setNote(event.target.value.slice(0, 400))}
        placeholder="Note for the record (optional)"
        aria-label="Decision note"
      />
      <div className="actions">
        {DECISION_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => void submit(action)}
            disabled={busy !== undefined}
            className={action === "REQUEST_SHUTDOWN" ? "danger" : undefined}
          >
            {busy === action ? "publishing…" : LABEL[action]}
          </button>
        ))}
      </div>
      {result && <p className="decide-result">{result}</p>}
    </div>
  );
}
