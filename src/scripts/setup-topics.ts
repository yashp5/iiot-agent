import {
  Key,
  KeyList,
  PrivateKey,
  PublicKey,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
import { readRequiredEnv } from "../shared/env";
import { createClient, parseOperatorKey } from "../shared/hedera";
import { TOPIC_ENV_VARS, type TopicName } from "../shared/topics";

/*
 * Creates the four HCS topics with per-topic submit keys:
 *   telemetry → device/gateway key   (only the boiler gateway can post readings)
 *   analysis  → agent key            (only the pipeline can post outliers/classifications)
 *   reports   → agent key
 *   decisions → operator key(s)      (only authorised humans can approve/escalate)
 * The operator account is the admin key on every topic so they can be updated later.
 * Missing device/operator keys are generated and printed
 once — copy them into .env.
 */
async function setupTopics() {
  const env = readRequiredEnv(["ACCOUNT_ID", "PRIVATE_KEY"]);
  const agentKey = parseOperatorKey(env.PRIVATE_KEY);
  const client = createClient(env.ACCOUNT_ID, agentKey);

  const generated: string[] = [];

  const deviceKey = process.env.DEVICE_PRIVATE_KEY?.trim()
    ? parseOperatorKey(process.env.DEVICE_PRIVATE_KEY, "DEVICE_PRIVATE_KEY")
    : generateKey("DEVICE_PRIVATE_KEY", generated);

  const decisionsKey = resolveOperatorSubmitKey(generated);

  const submitKeys: Record<TopicName, Key> = {
    telemetry: deviceKey.publicKey,
    analysis: agentKey.publicKey,
    reports: agentKey.publicKey,
    decisions: decisionsKey,
  };

  try {
    const lines: string[] = [];
    for (const [name, envName] of Object.entries(TOPIC_ENV_VARS) as Array<
      [TopicName, string]
    >) {
      const response = await new TopicCreateTransaction()
        .setTopicMemo(`iiot-boiler-guardian:${name}`)
        .setAdminKey(agentKey.publicKey)
        .setSubmitKey(submitKeys[name])
        .execute(client);
      const receipt = await response.getReceipt(client);
      const topicId = receipt.topicId?.toString();
      if (!topicId)
        throw new Error(`Topic creation
 for '${name}' returned no topic ID`);

      console.log(
        `created ${name.padEnd(9)} ${topicId}  https://hashscan.io/testnet/topic/${topicId}`,
      );
      lines.push(`${envName}=${topicId}`);
    }

    console.log("\nAdd to iiot-agent/.env:\n");
    console.log([...lines, ...generated].join("\n"));
    if (generated.length > 0) {
      console.log(
        "\nGenerated private keys are shown only once — store them now.",
      );
    }
  } finally {
    client.close();
  }
}

function generateKey(envName: string, generated: string[]): PrivateKey {
  const key = PrivateKey.generateECDSA();
  generated.push(`${envName}=${key.toStringDer()}`);
  return key;
}

/*
 * `OPERATOR_PUBLIC_KEYS` (comma-separated, e.g. HashPack account keys) plus optional
 * `OPERATOR_THRESHOLD` builds a threshold KeyList for multi-operator sign-off. Without
 * them a single local operator key is generated so the flow can be tested end to end.
 */
function resolveOperatorSubmitKey(generated: string[]): Key {
  const publicKeys = (process.env.OPERATOR_PUBLIC_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => PublicKey.fromString(value));

  if (publicKeys.length === 0) {
    return generateKey("OPERATOR_PRIVATE_KEY", generated).publicKey;
  }
  if (publicKeys.length === 1) {
    return publicKeys[0];
  }

  const threshold = Number(process.env.OPERATOR_THRESHOLD ?? 1);
  return new KeyList(publicKeys, threshold);
}

setupTopics().catch((error: unknown) => {
  console.error("Topic setup failed:");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
