import { Chat } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createRedisState } from "@chat-adapter/state-redis";
import { runAgent } from "./agent";
import { flushTelemetry } from "./telemetry";

export const bot = new Chat({
  userName: "data-analyst",
  adapters: { discord: createDiscordAdapter() },
  state: createRedisState(),
});

/** Only servers in DISCORD_ALLOWED_GUILD_IDS can use the bot. Empty list = nobody (fail closed). DMs are never allowed. */
const ALLOWED_GUILDS = new Set(
  (process.env.DISCORD_ALLOWED_GUILD_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);
if (ALLOWED_GUILDS.size === 0) console.warn("[Bot] DISCORD_ALLOWED_GUILD_IDS is empty: the bot will ignore every command");

const DISCORD_MAX = 2000;

/** Splits on newlines so Discord's 2000-char limit doesn't truncate the answer. */
function chunks(text: string): string[] {
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

// Discord shows "thinking..." (deferred response) until the first post; the interaction token lasts 15 min.
bot.onSlashCommand("/ask", async (event) => {
  const guildId = (event.raw as { guild_id?: string }).guild_id;
  if (!guildId || !ALLOWED_GUILDS.has(guildId)) {
    console.warn(`[Bot] Rejected /ask from guild ${guildId ?? "DM"} (user ${event.user.userId})`);
    await event.channel.post("Aquest bot no està disponible aquí.");
    return;
  }

  try {
    const answer = await runAgent([{ role: "user", content: event.text }], {
      trace: { userId: event.user.userName || event.user.userId, sessionId: event.channel.id, tags: ["discord", `guild:${guildId}`] },
    });
    for (const part of chunks(`> ${event.text}\n\n${answer}`)) await event.channel.post(part);
  } catch (error) {
    console.error("[Bot] /ask failed:", error);
    await event.channel.post("Ho sento, s'ha produït un error processant la consulta.");
  } finally {
    await flushTelemetry();
  }
});
