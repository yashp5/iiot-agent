import { parseArgs } from "node:util";
import { readRequiredEnv } from "../shared/env";
import { createClient, parseOperatorKey, publishJson } from "../shared/hedera";
import { DEFAULT_LIMITS } from "../shared/limits";
import type { AnalysisMessage, Decision, ReportRef } from "../shared/schemas";
import { loadTopicIds } from "../shared/topics";
import {
  DEFAULT_GATE_CONFIG,
  HaikuClassifier,
  shouldClassify,
  type Classifier,
  type DetectorEvent,
} from "./classifier";
import { REPORT_URGENCY_THRESHOLD, SonnetReporter, type Reporter } from "./reporter";
import { StatisticalLayer } from "./statistical";
import { subscribeDecisions, subscribeTelemetry, type ConsensusFrame } from "./subscriber";
import { TemporalLayer } from "./temporal";

/*
 * The worker: subscribes to telemetry on chain, runs layers 1–3, and publishes what it
 * finds back to the analysis topic.
 *
 *   npm run pipeline                      # live, from now
 *   npm run pipeline -- --from 600        # replay the last 10 minutes first
 *   npm run pipeline -- --dry-run         # analyse but publish nothing
 *   npm run pipeline -- --no-slm          # layers 1 and 2 only, no API calls
 *
 * It is long-running and holds a gRPC stream, so it belongs on a container host, not on
 * Vercel. It talks to the dashboard only through HCS topics.
 */

/**
 * Serialises analysis writes. Submitting concurrently lets two events reach consensus in
 * the opposite order to their detection — a CRITICAL landing before the WARN that
 * preceded it reads as a de-escalation that never happened. At a few events per minute
 * the added latency is irrelevant; the topic being a faithful log is not.
 */
class PublishQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  failures = 0;

  enqueue(publish: () => Promise<unknown>): void {
    this.pending += 1;
    this.tail = this.tail
      .then(() => publish())
      .then(
        () => undefined,
        (error: unknown) => {
          this.failures += 1;
          console.error(`publish failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      )
      .finally(() => {
        this.pending -= 1;
      });
  }

  get depth(): number {
    return this.pending;
  }

  /** Resolves once everything queued so far has been submitted. */
  drain(): Promise<void> {
    return this.tail;
  }
}

/** Per-boiler analysis state. Layers are stateful, so each boiler needs its own. */
interface BoilerContext {
  // Replaced wholesale when the gateway restarts, so these are not readonly.
  statistical: StatisticalLayer;
  temporal: TemporalLayer;
  lastClassifiedTs?: number;
  /** Reports are expensive and land in front of a human; re-issue only on escalation. */
  lastReport?: { ts: number; urgency: number };
  /** Set by an operator decision: stop reporting until this time unless urgency rises. */
  suppression?: { until: number; aboveUrgency: number; reason: Decision["action"] };
  frames: number;
}

/** Minimum gap between reports for one boiler, unless urgency rises. */
const REPORT_COOLDOWN_SEC = 300;

/**
 * How long an operator decision quiets reporting for. An acknowledgement means someone
 * owns the problem and does not need to be told again; a false positive means the
 * detectors were wrong, which is worth a longer silence and a note for threshold tuning.
 * Neither silences the detectors themselves — events keep reaching the analysis topic.
 */
const SUPPRESS_SEC: Record<Decision["action"], number> = {
  ACKNOWLEDGE: 900,
  FALSE_POSITIVE: 1800,
  ESCALATE: 0,
  REQUEST_SHUTDOWN: 0,
};

interface Options {
  fromSec: number;
  dryRun: boolean;
  useSlm: boolean;
  useReports: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      from: { type: "string", default: "0" },
      "dry-run": { type: "boolean", default: false },
      "no-slm": { type: "boolean", default: false },
      "no-reports": { type: "boolean", default: false },
    },
  });
  const fromSec = Number(values.from);
  if (!Number.isFinite(fromSec) || fromSec < 0) {
    console.error(`--from expects a non-negative number of seconds, got '${values.from}'.`);
    process.exit(1);
  }
  return {
    fromSec,
    dryRun: values["dry-run"],
    useSlm: !values["no-slm"],
    useReports: !values["no-slm"] && !values["no-reports"],
  };
}

async function runPipeline() {
  const options = parseOptions();
  const required = options.useSlm
    ? (["ACCOUNT_ID", "PRIVATE_KEY", "ANTHROPIC_API_KEY"] as const)
    : (["ACCOUNT_ID", "PRIVATE_KEY"] as const);
  const env = readRequiredEnv(required);

  const agentKey = parseOperatorKey(env.PRIVATE_KEY);
  const client = createClient(env.ACCOUNT_ID, agentKey);
  const topics = loadTopicIds();
  const classifier: Classifier | undefined = options.useSlm
    ? new HaikuClassifier(env.ANTHROPIC_API_KEY)
    : undefined;
  const reporter: Reporter | undefined = options.useReports
    ? new SonnetReporter(env.ANTHROPIC_API_KEY)
    : undefined;

  const boilers = new Map<string, BoilerContext>();
  const stats = { frames: 0, events: 0, classifications: 0, reports: 0, decisions: 0, gaps: 0, resets: 0 };
  const queue = new PublishQueue();

  const publish = (message: AnalysisMessage | ReportRef, topicId = topics.analysis) => {
    if (options.dryRun) return;
    // Queued rather than awaited: the subscription callback must keep up with 1 Hz
    // telemetry, but the writes themselves go out strictly in detection order.
    queue.enqueue(() => publishJson(client, topicId, message, agentKey));
  };

  const onFrame = ({ frame, sequenceNumber }: ConsensusFrame) => {
    const context = contextFor(boilers, frame.b);
    context.frames += 1;
    stats.frames += 1;

    const { stats: windowStats, events: outliers } = context.statistical.push(frame);
    const { events: patterns, features } = context.temporal.push(frame, windowStats);
    const events: DetectorEvent[] = [...outliers, ...patterns];

    for (const event of events) {
      stats.events += 1;
      console.log(
        `[${frame.b} hcs#${sequenceNumber}] ${event.severity} ${describe(event)}`,
      );
      publish(event);
    }

    if (!classifier) return;
    if (!shouldClassify(events, context.lastClassifiedTs, frame.ts, DEFAULT_GATE_CONFIG)) return;
    context.lastClassifiedTs = frame.ts;

    // Deliberately not awaited: the subscription callback must keep up with 1 Hz
    // telemetry, and a classification is about one window, not the live frame.
    void classifier
      .classify({ features, events })
      .then((classification) => {
        stats.classifications += 1;
        console.log(
          `[${frame.b}] SLM ${classification.state} urgency=${classification.urgency} ` +
            `confidence=${classification.confidence} — ${classification.recommendedAction}`,
        );
        for (const line of classification.evidence) console.log(`    · ${line}`);
        publish(classification);

        if (reporter && shouldReport(context, classification.urgency, frame.ts)) {
          context.lastReport = { ts: frame.ts, urgency: classification.urgency };
          void reporter
            .report({ classification, features, events, frames: context.statistical.frames })
            .then((report) => {
              stats.reports += 1;
              console.log(`[${frame.b}] REPORT ${report.id.slice(0, 8)} — ${report.summary}`);
              publish(report, topics.reports);
            })
            .catch((error: unknown) => {
              // A failed report must not stop analysis: the events and the classification
              // are already on chain, which is what the audit trail depends on.
              console.error(`report failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
      })
      .catch((error: unknown) => {
        console.error(`classify failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const onDecision = (decision: Decision, sequenceNumber: number) => {
    stats.decisions += 1;
    const context = contextFor(boilers, decision.b);
    const seconds = SUPPRESS_SEC[decision.action];

    console.log(
      `[${decision.b} decision#${sequenceNumber}] ${decision.action} by ${decision.operator}` +
        `${decision.note ? ` — ${decision.note}` : ""}`,
    );

    if (seconds > 0) {
      context.suppression = {
        until: Date.now() + seconds * 1000,
        // An escalating condition must still break through: silence is for the state the
        // operator saw, not for whatever the boiler does next.
        aboveUrgency: context.lastReport?.urgency ?? REPORT_URGENCY_THRESHOLD,
        reason: decision.action,
      };
      console.log(
        `    reports quiet for ${seconds / 60} min unless urgency exceeds ${context.suppression.aboveUrgency}`,
      );
    }
    if (decision.action === "FALSE_POSITIVE") {
      console.log("    logged for threshold tuning — detectors unchanged");
    }
    if (decision.action === "REQUEST_SHUTDOWN") {
      console.log("    shutdown requested by operator — this system is advisory and actuates nothing");
    }
  };

  const decisionSubscription = subscribeDecisions({
    client,
    topicId: topics.decisions,
    startTime: options.fromSec > 0 ? new Date(Date.now() - options.fromSec * 1000) : undefined,
    onDecision,
    onError: (error) => console.error(`decisions: ${error.message}`),
  });

  const subscription = subscribeTelemetry({
    client,
    topicId: topics.telemetry,
    startTime: options.fromSec > 0 ? new Date(Date.now() - options.fromSec * 1000) : undefined,
    onFrame,
    onGap: (boilerId, expected, received) => {
      stats.gaps += 1;
      console.error(`[${boilerId}] sequence gap: expected ${expected}, got ${received}`);
    },
    onReset: (boilerId, previous, received) => {
      stats.resets += 1;
      // Start clean. Carrying the old window across a restart produces statistics over
      // two unrelated runs — which reads as a confident verdict about a boiler that no
      // longer exists. Operator suppression survives: it is about the boiler, not the run.
      const context = contextFor(boilers, boilerId);
      context.statistical = new StatisticalLayer(boilerId);
      context.temporal = new TemporalLayer(boilerId);
      context.lastClassifiedTs = undefined;
      context.lastReport = undefined;
      context.frames = 0;
      console.error(
        `[${boilerId}] gateway restarted (seq ${previous} → ${received}) — analysis window reset`,
      );
    },
    onError: (error) => console.error(`subscription: ${error.message}`),
  });

  console.log(
    `watching telemetry ${topics.telemetry} and decisions ${topics.decisions}` +
      `${options.fromSec > 0 ? ` from ${options.fromSec}s ago` : ""}` +
      `, limits p<${DEFAULT_LIMITS.mawpBar} bar` +
      `${classifier ? "" : ", SLM disabled"}${reporter ? "" : ", reports disabled"}` +
      `${options.dryRun ? ", dry run" : ""}`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      subscription.unsubscribe();
      decisionSubscription.unsubscribe();
      if (queue.depth > 0) console.error(`\ndraining ${queue.depth} queued write(s)…`);
      void queue.drain().then(() => {
        console.error(
          `frames=${stats.frames} events=${stats.events} classifications=${stats.classifications} ` +
            `reports=${stats.reports} decisions=${stats.decisions} gaps=${stats.gaps} ` +
            `resets=${stats.resets} ` +
            `publishFailures=${queue.failures}`,
        );
        client.close();
        resolve();
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/** Report on a fresh incident, on any escalation, or once the cooldown lapses. */
function shouldReport(context: BoilerContext, urgency: number, now: number): boolean {
  if (urgency < REPORT_URGENCY_THRESHOLD) return false;

  const quiet = context.suppression;
  if (quiet && Date.now() < quiet.until && urgency <= quiet.aboveUrgency) return false;

  const last = context.lastReport;
  if (!last) return true;
  if (urgency > last.urgency) return true;
  return now - last.ts >= REPORT_COOLDOWN_SEC * 1000;
}

function contextFor(boilers: Map<string, BoilerContext>, boilerId: string): BoilerContext {
  let context = boilers.get(boilerId);
  if (!context) {
    context = {
      statistical: new StatisticalLayer(boilerId),
      temporal: new TemporalLayer(boilerId),
      frames: 0,
    };
    boilers.set(boilerId, context);
    console.log(`tracking boiler ${boilerId}`);
  }
  return context;
}

function describe(event: DetectorEvent): string {
  return event.kind === "outlier"
    ? `${event.method} on ${event.sensors.join("+")} (score ${event.score})`
    : `${event.pattern}: ${event.detail}`;
}

runPipeline().catch((error: unknown) => {
  console.error("Pipeline failed:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
