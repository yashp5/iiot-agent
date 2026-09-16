import { readRequiredEnv } from "./env";

/** The four HCS topics that form the system's only commu
nication channel. */
export const TOPIC_ENV_VARS = {
  telemetry: "TOPIC_TELEMETRY",
  analysis: "TOPIC_ANALYSIS",
  reports: "TOPIC_REPORTS",
  decisions: "TOPIC_DECISIONS",
} as const;

export type TopicName = keyof typeof TOPIC_ENV_VARS;
export type TopicIds = Record<TopicName, string>;

export function loadTopicIds(): TopicIds {
  const env = readRequiredEnv(Object.values(TOPIC_ENV_VARS));
  return {
    telemetry: env.TOPIC_TELEMETRY,
    analysis: env.TOPIC_ANALYSIS,
    reports: env.TOPIC_REPORTS,
    decisions: env.TOPIC_DECISIONS,
  };
}
