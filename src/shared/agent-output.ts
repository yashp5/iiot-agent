/*
 * Renders Anthropic-style structured content into readable lines.
 * Claude returns `content` as an array of blocks rather than a plain string, so a naive
 * `JSON.stringify` dumps tool-call payloads and base64 `thinking` signatures into the
 * console. Keep the text, summarise tool calls, and drop the signature noise.
 */
export function renderContentBlocks(
  blocks: readonly unknown[],
): string | undefined {
  const lines: string[] = [];

  for (const block of blocks) {
    if (typeof block === "string") {
      lines.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;

    const record = block as Record<string, unknown>;
    switch (record.type) {
      case "text": {
        if (typeof record.text === "string" && record.text.trim()) {
          lines.push(record.text);
        }
        break;
      }
      case "thinking":
        // The signature is an opaque blob; only surface actual reasoning text
        if (typeof record.thinking == "string" && record.thinking.trim()) {
          lines.push(`[thinking] ${record.thinking.trim()}`);
        }
        break;
      case "tool_use":
        const name =
          typeof record.name === "string" ? record.name : "unknown_tool";
        const input =
          record.input && Object.keys(record.input as object).length > 0
            ? JSON.stringify(record.input)
            : "";
        lines.push(`-> calling ${name}(${input})`);
        break;
      default:
        break;
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

/*
 * Pulls the newest message out of a LangGraph "updates" stream chunk.
 * Under langgraph 1.x the chunk is typed as the graph's state update, so `chunk.agent`
 * isn't statically indexable. Narrow from `unknown` rather than asserting the shape, and
 * print the *last* message since a single step can append several.
 */
export function latestAgentMessage(chunk: unknown): string | undefined {
  if (typeof chunk !== "object" || chunk === null) return undefined;

  const agentStep = (chunk as Record<string, unknown>).agent;
  if (typeof agentStep !== "object" || agentStep === null) return undefined;

  const messages = (agentStep as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const latest: unknown = messages[messages.length - 1];
  if (typeof latest !== "object" || latest === null) return undefined;

  const content = (latest as Record<string, unknown>).content;
  if (typeof content === "string") return content.trim() || undefined;
  if (Array.isArray(content)) return renderContentBlocks(content);
  return undefined;
}
