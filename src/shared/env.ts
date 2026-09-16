import * as dotenv from "dotenv";

// quiet: the banner would land on stdout and corrupt `npm run sim -- --dry-run | jq`.
dotenv.config({ quiet: true });

/** Human-readable hints printed when a variable is missing, keyed by variable name. */
const ENV_HINTS: Record<string, string> = {
  ACCOUNT_ID: "your Hedera testnet account, e.g. 0.0.12345",
  PRIVATE_KEY: "the DER Encoded Private Key from the Hedera Portal",
  ANTHROPIC_API_KEY: "an Anthropic API key",
  DEVICE_PRIVATE_KEY:
    "gateway key that signs telemetry(printed by `npm run setup:topics`)",
  TOPIC_TELEMETRY:
    "HCS topic ID for 1 Hz sensor frames(printed by `npm run setup:topics`)",
  TOPIC_ANALYSIS: "HCS topic ID for outlier/pattern/classification events",
  TOPIC_REPORTS: "HCS topic ID for incident report references",
  TOPIC_DECISIONS: "HCS topic ID for operator decisions",
};

/**
 * Validates credentials up front so a missing or placeholder value fails with a clear
 * message instead of exploding deep inside the Hiero SDK or the Anthropic client.
 */
export function readRequiredEnv<const T extends readonly string[]>(
  names: T,
): Record<T[number], string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const placeholders: string[] = [];

  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
    } else if (value.includes("...")) {
      // No real credential contains an ellipsis, so this reliably catches truncated
      // sample values pasted out of docs without risking a false positive.
      placeholders.push(name);
    } else {
      values[name] = value;
    }
  }

  if (missing.length > 0) {
    console.error(
      `Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    );
  }

  if (placeholders.length > 0) {
    console.error(
      `Placeholder value${placeholders.length > 1 ? "s" : ""} still in .env: ${placeholders.join(", ")}`,
    );
    console.error(
      "Replace the truncated sample value(s) with real credentials.",
    );
  }

  const invalid = [...missing, ...placeholders];
  if (invalid.length > 0) {
    console.error("\nExpected in iiot-agent/.env:");
    for (const name of invalid) {
      console.error(`  ${name.padEnd(20)} ${ENV_HINTS[name] ?? ""}`);
    }
    process.exit(1);
  }

  return values as Record<T[number], string>;
}
