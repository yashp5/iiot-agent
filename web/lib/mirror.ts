import {
  AnalysisMessageSchema,
  ReportRefSchema,
  TelemetryFrameSchema,
  type AnalysisMessage,
  type ReportRef,
  type TelemetryFrame,
} from "@shared/schemas";

/*
 * Server-side reader for the Hedera mirror node.
 *
 * The dashboard never talks to the pipeline or the simulator — it reads the same topics
 * they write, so what it shows is what the chain says. Mirror REST is polled rather than
 * streamed: a Vercel function cannot hold the gRPC subscription the worker uses, and with
 * consensus latency around 400 ms a 2 s poll adds little.
 */

const MIRROR = process.env.MIRROR_BASE_URL ?? "https://testnet.mirrornode.hedera.com/api/v1";

export const TOPIC_ENV = {
  telemetry: "TOPIC_TELEMETRY",
  analysis: "TOPIC_ANALYSIS",
  reports: "TOPIC_REPORTS",
  decisions: "TOPIC_DECISIONS",
} as const;

export type TopicName = keyof typeof TOPIC_ENV;

interface MirrorMessage {
  consensus_timestamp: string;
  sequence_number: number;
  message: string;
  chunk_info?: {
    number?: number;
    total?: number;
    initial_transaction_id?: { transaction_valid_start?: string; account_id?: string };
  };
}

export interface TopicRecord<T> {
  sequenceNumber: number;
  consensusTimestamp: string;
  payload: T;
}

export function topicId(name: TopicName): string {
  const id = process.env[TOPIC_ENV[name]];
  if (!id) throw new Error(`${TOPIC_ENV[name]} is not set`);
  return id;
}

/**
 * Messages over 1024 bytes are split across several HCS messages, and mirror REST returns
 * each chunk as its own entry — so a report arrives as N rows that have to be joined by
 * their initial transaction id before the JSON parses. The gRPC subscriber the worker uses
 * reassembles transparently; a REST reader must do it itself.
 */
function reassemble(messages: MirrorMessage[]): Array<{ seq: number; ts: string; text: string }> {
  const groups = new Map<string, MirrorMessage[]>();

  for (const message of messages) {
    const initial = message.chunk_info?.initial_transaction_id;
    const key = initial?.transaction_valid_start
      ? `${initial.account_id ?? ""}@${initial.transaction_valid_start}`
      : `single:${message.sequence_number}`;
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }

  const records: Array<{ seq: number; ts: string; text: string }> = [];
  for (const parts of groups.values()) {
    const total = parts[0]?.chunk_info?.total ?? 1;
    // An incomplete group means the rest of the chunks are on the next page; skip it
    // rather than handing a truncated body to the parser.
    if (parts.length < total) continue;
    const ordered = [...parts].sort(
      (a, b) => (a.chunk_info?.number ?? 1) - (b.chunk_info?.number ?? 1),
    );
    const last = ordered[ordered.length - 1];
    records.push({
      seq: last.sequence_number,
      ts: last.consensus_timestamp,
      text: ordered.map((part) => Buffer.from(part.message, "base64").toString("utf8")).join(""),
    });
  }

  return records.sort((a, b) => a.seq - b.seq);
}

async function fetchTopic(
  name: TopicName,
  options: { limit?: number; since?: string } = {},
): Promise<Array<{ seq: number; ts: string; text: string }>> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
    order: "desc",
  });
  if (options.since) params.set("timestamp", `gt:${options.since}`);

  const response = await fetch(`${MIRROR}/topics/${topicId(name)}/messages?${params}`, {
    // Always live: a cached telemetry page would silently freeze the dashboard.
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`mirror ${response.status} for topic ${name}`);

  const body = (await response.json()) as { messages?: MirrorMessage[] };
  return reassemble(body.messages ?? []);
}

/** Records that fail validation are dropped: an open topic can carry anything. */
function parseAll<T>(
  records: Array<{ seq: number; ts: string; text: string }>,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): Array<TopicRecord<T>> {
  const out: Array<TopicRecord<T>> = [];
  for (const record of records) {
    try {
      const result = parse(JSON.parse(record.text));
      if (result.success) {
        out.push({ sequenceNumber: record.seq, consensusTimestamp: record.ts, payload: result.data });
      }
    } catch {
      // non-JSON message on the topic — ignore
    }
  }
  return out;
}

export async function getTelemetry(since?: string): Promise<Array<TopicRecord<TelemetryFrame>>> {
  const records = await fetchTopic("telemetry", { limit: 200, since });
  return parseAll(records, (v) => TelemetryFrameSchema.safeParse(v));
}

export async function getAnalysis(since?: string): Promise<Array<TopicRecord<AnalysisMessage>>> {
  const records = await fetchTopic("analysis", { limit: 100, since });
  return parseAll(records, (v) => AnalysisMessageSchema.safeParse(v));
}

export async function getReports(): Promise<Array<TopicRecord<ReportRef>>> {
  const records = await fetchTopic("reports", { limit: 100 });
  return parseAll(records, (v) => ReportRefSchema.safeParse(v));
}
