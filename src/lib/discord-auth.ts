/**
 * Validates guild access against configured whitelist.
 * If DISCORD_ALLOWED_GUILD_IDS is empty/not set, all guilds allowed (dev mode).
 * DMs (null guild_id) are blocked when whitelist is active.
 */
export function validateGuildAccess(guildId: string | null): boolean {
  const allowedGuilds = process.env.DISCORD_ALLOWED_GUILD_IDS?.split(',')
    .map(id => id.trim())
    .filter(Boolean) ?? [];

  // No whitelist configured - allow all (dev mode)
  if (allowedGuilds.length === 0) return true;

  // DMs blocked if whitelist active
  if (!guildId) return false;

  return allowedGuilds.includes(guildId);
}
