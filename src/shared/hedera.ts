import {
  Client,
  PrivateKey,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";

/** HCS rejects a single chunk above this size; larger p
ayloads are split by the SDK. */
export const HCS_CHUNK_BYTES = 1024;

/*
 * Parses a private key, failing with an actionable message rather than letting a raw
 * "Invalid hex string" bubble up from inside @hiero-ledger/cryptography.
 * `fromStringDer` auto-detects ED25519 vs ECDSA from the DER prefix, so it's the right
 * choice for the DER-encoded keys the Hedera Portal hands out. Raw 32-byte hex keys copied
 * out of a wallet have no DER header and need an explicit curve, so those try ECDSA first
 * (the Portal default) and fall back to ED25519.
 */
export function parseOperatorKey(
  rawKey: string,
  envName = "PRIVATE_KEY",
): PrivateKey {
  const key = rawKey.trim().replace(/^0x/i, "");

  if (!/^[0-9a-fA-F]+$/.test(key) || key.length % 2 !== 0 || key.length < 64) {
    // Short values are safe to echo and are almost always leftover placeholders; a real
    // key is >= 64 chars and is never printed.
    const shown = key.length <= 16 ? ` (${JSON.stringify(key)})` : "";
    console.error(
      `${envName} is not a valid Hedera private key: got a ${key.length}-character value${shown}.`,
    );
    console.error(
      "Expected an even-length hex string of at least 64 characters — either a raw " +
        "32-byte key or a longer DER-encoded key, optionally 0x-prefixed.",
    );
    console.error(
      "If this is still a placeholder, copy the 'DER Encoded Private Key' from your " +
        "Hedera Portal testnet account into iiot-agent/.env.",
    );
    process.exit(1);
  }

  const parsers: Array<[string, (text: string) => PrivateKey]> = key.startsWith(
    "30",
  )
    ? [["DER", (text) => PrivateKey.fromStringDer(text)]]
    : [
        ["ECDSA", (text) => PrivateKey.fromStringECDSA(text)],
        ["ED25519", (text) => PrivateKey.fromStringED25519(text)],
      ];

  const failures: string[] = [];
  for (const [label, parse] of parsers) {
    try {
      return parse(key);
    } catch (error) {
      failures.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.error(
    `Could not parse ${envName}. Attempts: \n ${failures.join("\n  ")}`,
  );
  process.exit(1);
}

/* Testnet client whose operator account pays fees for every transaction it executes. */
export function createClient(
  accountId: string,
  operatorKey: PrivateKey,
): Client {
  // Use Client.forMainnet() for production
  return Client.forTestnet().setOperator(accountId, operatorKey);
}

export interface PublishResult {
  topicId: string;
  sequenceNumber: number;
}

/*
 * Submits a JSON payload to an HCS topic and waits for consensus.
 * Topics created by `setup-topics` carry a submit key, so the matching key must co-sign;
 * the client operator still pays the fee. This is what makes each message attributable
 * to a device, the agent, or an operator.
 */
export async function publishJson(
  client: Client,
  topicId: string,
  payload: unknown,
  submitKey?: PrivateKey,
): Promise<PublishResult> {
  const message = JSON.stringify(payload);
  const transaction = new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(message)
    // Reports can exceed one chunk; telemetry frames are kept far below it.
    .setMaxChunks(20)
    .freezeWith(client);

  if (submitKey) {
    await transaction.sign(submitKey);
  }

  const response = await transaction.execute(client);
  const receipt = await response.getReceipt(client);

  return {
    topicId,
    sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? -1,
  };
}

/** Submits without waiting for consensus. Use for the 1 Hz telemetry hot path. */
export async function submitJson(
  client: Client,
  topicId: string,
  payload: unknown,
  submitKey?: PrivateKey,
): Promise<string> {
  const tx = new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(JSON.stringify(payload))
    .setMaxChunks(20)
    .freezeWith(client);
  if (submitKey) await tx.sign(submitKey);
  const response = await tx.execute(client);
  return response.transactionId.toString();
}
