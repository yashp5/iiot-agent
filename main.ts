import { AgentMode } from "@hashgraph/hedera-agent-kit";
import { HederaLangchainToolkit } from "@hashgraph/hedera-agent-kit-langchain";
import {
  coreAccountPlugin,
  coreAccountQueryPlugin,
  coreConsensusPlugin,
} from "@hashgraph/hedera-agent-kit/plugins";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
// import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import * as dotenv from "dotenv";
import { latestAgentMessage } from "./src/shared/agent-output";
import { readRequiredEnv } from "./src/shared/env";
import { createClient, parseOperatorKey } from "./src/shared/hedera";

dotenv.config();

const REQUIRED_ENV_VARS = [
  "ACCOUNT_ID",
  "PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
] as const;

async function runHederaAgent() {
  const env = readRequiredEnv([
    "ACCOUNT_ID",
    "PRIVATE_KEY",
    "ANTHROPIC_API_KEY",
  ]);
  const client = createClient(
    env.ACCOUNT_ID,
    parseOperatorKey(env.PRIVATE_KEY),
  );

  const toolkit = new HederaLangchainToolkit({
    client,
    configuration: {
      plugins: [coreAccountPlugin, coreAccountQueryPlugin, coreConsensusPlugin],
      context: {
        mode: AgentMode.AUTONOMOUS,
        accountId: env.ACCOUNT_ID,
      },
    },
  });

  const llm = new ChatAnthropic({
    model: "claude-sonnet-5",
    apiKey: env.ANTHROPIC_API_KEY,
    maxTokens: 4096,
  });
  const tools = toolkit.getTools();
  const agent = createReactAgent({ llm, tools });

  const prompt =
    "Can you check my HBAR balance? If I have any, create a new consensus topic called 'AI Audit Trail'.";

  console.log(`User: ${prompt}\n`);

  try {
    const stream = await agent.stream({
      messages: [{ role: "user", content: prompt }],
    });

    for await (const chunk of stream) {
      const message = latestAgentMessage(chunk);
      if (message) {
        console.log(message);
      }
    }
  } finally {
    client.close();
  }
}

runHederaAgent().catch((error: unknown) => {
  console.error("Hedera agent run failed:");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
