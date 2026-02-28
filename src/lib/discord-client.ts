import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { handleAgentMessage } from './handle-message';
import { validateGuildAccess } from './discord-auth';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot ready as ${readyClient.user.tag}`);
  readyClient.user.setActivity('data analysis', { type: ActivityType.Watching });
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check guild whitelist
  if (!validateGuildAccess(message.guildId)) return;

  // Only respond to @mentions
  const botMention = `<@${client.user?.id}>`;
  const isMentioned = message.mentions.users.has(client.user?.id ?? '') ||
    message.content.includes(botMention);

  if (!isMentioned) return;

  try {
    await handleAgentMessage(message);
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      await message.reply('An error occurred while processing your request.');
    } catch {
      await message.channel.send('An error occurred while processing your request.');
    }
  }
});

export async function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is required');
  }
  await client.login(token);
  return client;
}
