import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Client } from "@hiero-ledger/sdk";
import { readRequiredEnv } from "../shared/env";
import { createClient, parseOperatorKey, submitJson } from "../shared/hedera";
import { loadTopicIds } from "../shared/topics";
import type { TelemetryFrame } from "../shared/schemas";
import { BoilerSim } from "./boiler";
import { createFault, FAULT_NAMES, type Fault, type FaultName } from "./faults";
import { createRng } from "./random";

/*
 * Boiler telemetry source: steps the simulator once per tick and submits each frame
 * to the telemetry topic, signed with the device key.
 *
 *   npm run sim -- --dry-run --duration 120 --fault overpressure --start 30
 *   npm run sim -- --duration 600 --fault o2_collapse --start 60
 *
 * One tick is always one simulated second; --rate only changes how fast wall-clock
 * time runs, so a 600 s scenario can be replayed in a minute during development.
 */

/** Consensus takes 3–5 s, so submissions overlap. Past this many in flight the network
 *  is not keeping up and queueing further would decouple readings from their timestamps. */
const MAX_IN_FLIGHT = 20;

/** How long to wait for outstanding submissions after the last tick. */
const DRAIN_TIMEOUT_MS = 15_000;

interface Options {
  boilerId: string;
  faultName?: FaultName;
  startSec: number;
  durationSec: number;
  seed: number;
  rateMs: number;
  dryRun: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      boiler: { type: "string", default: "boiler-01" },
      fault: { type: "string" },
      start: { type: "string", default: "60" },
      duration: { type: "string", default: "600" },
      seed: { type: "string", default: "42" },
      rate: { type: "string", default: "1000" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const faultName = values.fault;
  if (faultName !== undefined && !(FAULT_NAMES as readonly string[]).includes(faultName)) {
    console.error(`Unknown --fault '${faultName}'. Expected one of: ${FAULT_NAMES.join(", ")}`);
    process.exit(1);
  }

  return {
    boilerId: values.boiler,
    faultName: faultName as FaultName | undefined,
    startSec: parseCount(values.start, "--start"),
    durationSec: parseCount(values.duration, "--duration"),
    seed: parseCount(values.seed, "--seed"),
    rateMs: parseCount(values.rate, "--rate"),
    dryRun: values["dry-run"],
  };
}

function parseCount(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${flag} expects a non-negative number, got '${raw}'.`);
    process.exit(1);
  }
  return value;
}

/**
 * Fire-and-forget submitter. Telemetry is not awaited tick by tick: waiting for a
 * receipt costs several seconds per frame, which at 1 Hz would fall permanently behind.
 * The pipeline's mirror subscription is what confirms a frame actually landed.
 */
class TelemetryPublisher {
  private inFlight = 0;
  readonly stats = { submitted: 0, failed: 0, dropped: 0 };

  constructor(
    private readonly client: Client,
    private readonly topicId: string,
    private readonly deviceKey: ReturnType<typeof parseOperatorKey>,
  ) {}

  publish(frame: TelemetryFrame): void {
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.stats.dropped += 1;
      return;
    }

    this.inFlight += 1;
    void submitJson(this.client, this.topicId, frame, this.deviceKey)
      .then(() => {
        this.stats.submitted += 1;
      })
      .catch((error: unknown) => {
        this.stats.failed += 1;
        // Repeating an identical network error once per second buries everything else.
        if (this.stats.failed <= 5) {
          console.error(
            `submit failed (seq ${frame.seq}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  async drain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await sleep(250);
    }
  }
}

async function runSim() {
  const options = parseOptions();
  const sim = new BoilerSim(createRng(options.seed));
  const fault: Fault | undefined = options.faultName ? createFault(options.faultName) : undefined;

  let client: Client | undefined;
  let publisher: TelemetryPublisher | undefined;

  if (!options.dryRun) {
    const env = readRequiredEnv(["ACCOUNT_ID", "PRIVATE_KEY", "DEVICE_PRIVATE_KEY"]);
    client = createClient(env.ACCOUNT_ID, parseOperatorKey(env.PRIVATE_KEY));
    // The operator account pays the fee, but only the device key satisfies the
    // telemetry topic's submit key — that is what makes a frame attributable.
    const deviceKey = parseOperatorKey(env.DEVICE_PRIVATE_KEY, "DEVICE_PRIVATE_KEY");
    publisher = new TelemetryPublisher(client, loadTopicIds().telemetry, deviceKey);
  }

  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error("\nstopping after current tick…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.error(
    `${options.boilerId}: ${options.durationSec} ticks, fault=${options.faultName ?? "none"}` +
      `${fault ? ` at t+${options.startSec}s` : ""}, seed=${options.seed}` +
      `${options.dryRun ? ", dry run" : ""}`,
  );

  try {
    const startedAt = Date.now();
    for (let tick = 0; tick < options.durationSec && !stopping; tick++) {
      // Schedule against absolute start time; sleeping a fixed period each iteration
      // accumulates drift, which would show up in the consensus timestamps.
      await sleep(Math.max(0, startedAt + tick * options.rateMs - Date.now()));

      sim.step();
      if (fault && tick >= options.startSec) {
        fault.apply(sim, tick - options.startSec);
      }

      const frame = sim.read(options.boilerId);
      if (publisher) {
        publisher.publish(frame);
        if (tick % 10 === 0) {
          console.error(
            `t+${tick}s  p=${frame.p} bar  t=${frame.t} °C  o2=${frame.o2} %  ` +
              `(sent ${publisher.stats.submitted}, failed ${publisher.stats.failed}, dropped ${publisher.stats.dropped})`,
          );
        }
      } else {
        // stdout carries frames only, so `npm run sim -- --dry-run | jq` works.
        console.log(JSON.stringify(frame));
      }
    }

    if (publisher) {
      await publisher.drain();
      const { submitted, failed, dropped } = publisher.stats;
      console.error(`done: ${submitted} submitted, ${failed} failed, ${dropped} dropped`);
    }
  } finally {
    // Open gRPC channels keep the process alive otherwise.
    client?.close();
  }
}

runSim().catch((error: unknown) => {
  console.error("Simulator run failed:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
