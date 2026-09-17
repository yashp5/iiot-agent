import { TopicId, TopicMessageQuery, Timestamp, type Client, type SubscriptionHandle } from "@hiero-ledger/sdk";
import { DecisionSchema, TelemetryFrameSchema, type Decision, type TelemetryFrame } from "../shared/schemas";

/*
 * Mirror-node subscription. This is the gRPC streaming path, not REST polling: the
 * mirror node pushes each message as it reaches consensus, which is the protocol-level
 * equivalent of a websocket and the reason the worker cannot run on Vercel.
 *
 * Everything downstream reads the chain, never the simulator — the topic is the only
 * interface between the two halves of the system.
 */

export interface ConsensusFrame {
  frame: TelemetryFrame;
  /** Assigned by consensus, not by the device: the authoritative ordering. */
  sequenceNumber: number;
  consensusTimestamp: Date;
}

export interface SubscribeOptions {
  client: Client;
  topicId: string;
  /** Where to start reading. Omit for "now"; pass a past time to replay history. */
  startTime?: Date;
  onFrame: (frame: ConsensusFrame) => void;
  /** A frame the device numbered out of order, or one that never arrived. */
  onGap?: (boilerId: string, expectedSeq: number, receivedSeq: number) => void;
  /**
   * The device's counter went backwards, which means a new gateway session rather than a
   * lost frame. The readings either side of it belong to different runs of the plant, so
   * any window spanning the boundary is meaningless and must be discarded.
   */
  onReset?: (boilerId: string, previousSeq: number, newSeq: number) => void;
  onError?: (error: Error) => void;
}

export function subscribeTelemetry(options: SubscribeOptions): SubscriptionHandle {
  const lastSeqByBoiler = new Map<string, number>();

  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(options.topicId))
    .setStartTime(Timestamp.fromDate(options.startTime ?? new Date()));

  return query.subscribe(
    options.client,
    (_message, error) => options.onError?.(error),
    (message) => {
      const raw = Buffer.from(message.contents).toString("utf8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Anyone holding the submit key can write anything; malformed messages are a
        // fact of an open topic, not an exception.
        options.onError?.(new Error(`non-JSON message at seq ${message.sequenceNumber.toString()}`));
        return;
      }

      const result = TelemetryFrameSchema.safeParse(parsed);
      if (!result.success) {
        options.onError?.(
          new Error(`schema mismatch at seq ${message.sequenceNumber.toString()}: ${result.error.issues[0]?.message}`),
        );
        return;
      }

      const frame = result.data;
      const previous = lastSeqByBoiler.get(frame.b);
      if (previous !== undefined) {
        if (frame.seq <= previous) {
          options.onReset?.(frame.b, previous, frame.seq);
        } else if (frame.seq !== previous + 1) {
          // The device's own counter, not the HCS sequence: this is how a dropped or
          // reordered submission becomes visible from the consuming side.
          options.onGap?.(frame.b, previous + 1, frame.seq);
        }
      }
      lastSeqByBoiler.set(frame.b, frame.seq);

      options.onFrame({
        frame,
        sequenceNumber: message.sequenceNumber.toNumber(),
        consensusTimestamp: message.consensusTimestamp.toDate(),
      });
    },
  );
}

export interface DecisionSubscription {
  client: Client;
  topicId: string;
  startTime?: Date;
  onDecision: (decision: Decision, sequenceNumber: number) => void;
  onError?: (error: Error) => void;
}

/**
 * The return path: operators publish decisions, the worker reads them. The two never
 * talk directly — an acknowledgement reaches the pipeline the same way a reading does,
 * through consensus, and is just as auditable.
 */
export function subscribeDecisions(options: DecisionSubscription): SubscriptionHandle {
  return new TopicMessageQuery()
    .setTopicId(TopicId.fromString(options.topicId))
    .setStartTime(Timestamp.fromDate(options.startTime ?? new Date()))
    .subscribe(
      options.client,
      (_message, error) => options.onError?.(error),
      (message) => {
        const raw = Buffer.from(message.contents).toString("utf8");
        try {
          const result = DecisionSchema.safeParse(JSON.parse(raw));
          if (!result.success) {
            options.onError?.(
              new Error(`decision schema mismatch at seq ${message.sequenceNumber.toString()}`),
            );
            return;
          }
          options.onDecision(result.data, message.sequenceNumber.toNumber());
        } catch {
          options.onError?.(
            new Error(`non-JSON decision at seq ${message.sequenceNumber.toString()}`),
          );
        }
      },
    );
}
