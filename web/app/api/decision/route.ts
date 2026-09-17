import { NextResponse } from "next/server";
import { createClient, parseOperatorKey, publishJson } from "@shared/hedera";
import { DECISION_ACTIONS, DecisionSchema, type Decision } from "@shared/schemas";
import { topicId } from "@/lib/mirror";

/*
 * Publishes an operator's decision to the decisions topic.
 *
 * The signature comes from OPERATOR_PRIVATE_KEY, which the analysis worker does not hold:
 * the topic's submit key rejects the agent key, so the pipeline cannot manufacture its own
 * approval. That is the property this route exists to preserve.
 *
 * It is not yet full non-repudiation — the key lives on the server, so the decision proves
 * "someone with operator authority on this deployment", not "this named person". Moving to
 * a wallet signature (hedera-wallet-connect, the operator signing in HashPack) replaces
 * only the signing step below; the message, the topic, and the worker's handling are the
 * same either way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let submitted: Decision;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (!(DECISION_ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json(
        { error: `action must be one of ${DECISION_ACTIONS.join(", ")}` },
        { status: 400 },
      );
    }

    const parsed = DecisionSchema.safeParse({
      v: 1,
      kind: "decision",
      reportId: String(body.reportId ?? ""),
      b: String(body.b ?? ""),
      action,
      operator: process.env.OPERATOR_NAME ?? "operator",
      note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined,
      ts: Date.now(),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
    }
    submitted = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const accountId = process.env.ACCOUNT_ID;
  const payerKey = process.env.PRIVATE_KEY;
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
  if (!accountId || !payerKey || !operatorKey) {
    return NextResponse.json(
      { error: "ACCOUNT_ID, PRIVATE_KEY and OPERATOR_PRIVATE_KEY must be set" },
      { status: 500 },
    );
  }

  // The operator account pays the fee; the operator key is what satisfies the submit key.
  const client = createClient(accountId, parseOperatorKey(payerKey));
  try {
    const result = await publishJson(
      client,
      topicId("decisions"),
      submitted,
      parseOperatorKey(operatorKey, "OPERATOR_PRIVATE_KEY"),
    );
    return NextResponse.json({ decision: submitted, sequenceNumber: result.sequenceNumber });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "submit failed" },
      { status: 502 },
    );
  } finally {
    client.close();
  }
}
