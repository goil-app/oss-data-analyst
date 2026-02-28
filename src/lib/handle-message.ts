import type { UIMessage } from "ai";
import type { Message, TextBasedChannel } from "discord.js";
import { estimateCost } from "tokenlens";
import { runAgent, extractFinalizeReport } from "./agent";

export async function handleAgentMessage(message: Message) {
  // Show typing indicator while processing
  const channel = message.channel as TextBasedChannel;
  if ('sendTyping' in channel) {
    await channel.sendTyping();
  }

  const typingInterval = setInterval(() => {
    if ('sendTyping' in channel) channel.sendTyping();
  }, 5_000);

  try {
    // Fetch channel history (newest first, then reverse), fall back to just current message
    let uiMessages: UIMessage[];
    try {
      const messages = await channel.messages.fetch({ limit: 50 });
      uiMessages = messages
        .reverse()
        .map((m) => ({
          id: m.id,
          role: m.author.bot ? "assistant" : "user",
          parts: [{ type: "text", text: m.content }],
        }));
    } catch {
      uiMessages = [];
    }

    // Ensure current message is included
    if (!uiMessages.find((m) => m.id === message.id)) {
      uiMessages.push({
        id: message.id,
        role: "user",
        parts: [{ type: "text", text: message.content }],
      });
    }

    // Run agent
    const result = await runAgent({ messages: uiMessages });

    // Consume stream to completion
    for await (const _ of result.textStream) { /* drain */ }

    // Extract FinalizeReport narrative as the reply
    const steps = await result.steps;

    // Log token usage and cost
    const usage = steps.reduce(
      (acc, s) => {
        acc.inputTokens += s.usage?.inputTokens ?? 0;
        acc.outputTokens += s.usage?.outputTokens ?? 0;
        acc.cachedInputTokens += s.usage?.cachedInputTokens ?? 0;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    );
    const cost = estimateCost({ modelId: "claude-sonnet-4-6", usage: { input: usage.inputTokens, output: usage.outputTokens, cacheReads: usage.cachedInputTokens } }).totalUSD;
    console.log(`[Agent] Request completed — input: ${usage.inputTokens}, output: ${usage.outputTokens}, cached: ${usage.cachedInputTokens}, cost: $${(cost ?? 0).toFixed(4)}`);

    const allToolResults = steps.flatMap((s) => s.toolResults ?? []);
    const { narrative } = extractFinalizeReport({ toolResults: allToolResults });

    const text = narrative ?? "Sorry, I couldn't generate a response.";

    // Reply if we can, otherwise send (requires Read Message History permission)
    try {
      await message.reply(text);
    } catch {
      if ('send' in channel) await channel.send(text);
    }
  } finally {
    clearInterval(typingInterval);
  }
}
