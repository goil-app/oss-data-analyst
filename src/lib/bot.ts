import { Chat } from "chat";
import type { ModelMessage } from "ai";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createRedisState } from "@chat-adapter/state-redis";
import { runAgent } from "./agent";
import { liveProgress } from "./progress";
import { flushTelemetry } from "./telemetry";

const state = createRedisState();

export const bot = new Chat({
  userName: "data-analyst",
  adapters: { discord: createDiscordAdapter() },
  state,
});

// Follow-ups ("and last month?"): the last turns of each user in each channel, forgotten after 30 min
const HISTORY_TURNS = 3;
const HISTORY_TTL_MS = 30 * 60_000;
const historyKey = (channelId: string, userId: string) => `history:${channelId}:${userId}`;

/** Only servers in DISCORD_ALLOWED_GUILD_IDS can use the bot. Empty list = nobody (fail closed). DMs are never allowed. */
const ALLOWED_GUILDS = new Set(
  (process.env.DISCORD_ALLOWED_GUILD_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);
if (ALLOWED_GUILDS.size === 0) console.warn("[Bot] DISCORD_ALLOWED_GUILD_IDS is empty: the bot will ignore every command");

const DISCORD_MAX = 2000;

/** Splits on newlines so Discord's 2000-char limit doesn't truncate the answer. */
export function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > DISCORD_MAX) {
    const cut = rest.lastIndexOf("\n", DISCORD_MAX);
    const at = cut > 0 ? cut : DISCORD_MAX;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return [...out, rest];
}

/** Edits a slash command's first reply. Interaction webhooks need no bot auth and work in any channel for 15 min. */
async function editOriginal(token: string, content: string) {
  const res = await fetch(`https://discord.com/api/v10/webhooks/${process.env.DISCORD_APPLICATION_ID}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Discord edit failed: ${res.status} ${await res.text()}`);
}

// Discord shows "thinking..." (deferred response) until the first post; the interaction token lasts 15 min.
bot.onSlashCommand("/ask", async (event) => {
  const guildId = (event.raw as { guild_id?: string }).guild_id;
  if (!guildId || !ALLOWED_GUILDS.has(guildId)) {
    console.warn(`[Bot] Rejected /ask from guild ${guildId ?? "DM"} (user ${event.user.userId})`);
    await event.channel.post("Aquest bot no està disponible aquí.");
    return;
  }

  // Live progress: one status message edited as tools run, then replaced by the answer
  // Edited through the interaction webhook, not the bot token: the bot may lack access to the channel (403 Missing Access)
  await event.channel.post("🤔 Pensant…");
  const { token } = event.raw as { token: string };
  const editStatus = (content: string) => editOriginal(token, content);
  const progress = liveProgress(editStatus);
  try {
    const key = historyKey(event.channel.id, event.user.userId);
    const history = await state.getList<ModelMessage>(key);
    const answer = await runAgent([...history, { role: "user", content: event.text }], {
      trace: { userId: event.user.userName || event.user.userId, sessionId: event.channel.id, tags: ["discord", `guild:${guildId}`] },
      onProgress: progress.add,
    });
    await progress.done();
    const [first, ...rest] = chunks(`> ${event.text}\n\n${answer.narrative}`);
    await editStatus(first);
    for (const part of rest) await event.channel.post(part);

    const turn: ModelMessage[] = [
      { role: "user", content: event.text },
      { role: "assistant", content: answer.query ? `${answer.narrative}\n\nQuery: ${answer.query}` : answer.narrative },
    ];
    for (const m of turn) await state.appendToList(key, m, { maxLength: HISTORY_TURNS * 2, ttlMs: HISTORY_TTL_MS });
  } catch (error) {
    console.error("[Bot] /ask failed:", error);
    await progress.done();
    await editStatus("Ho sento, s'ha produït un error processant la consulta.");
  } finally {
    await flushTelemetry();
  }
});
