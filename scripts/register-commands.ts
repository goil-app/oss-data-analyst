// Registers /ask in every allowed guild (guild commands show up instantly): pnpm register-commands
const { DISCORD_APPLICATION_ID: app, DISCORD_BOT_TOKEN: token, DISCORD_ALLOWED_GUILD_IDS: guilds = "" } = process.env;
if (!app || !token) throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");

const commands = [
  {
    name: "ask",
    description: "Fes una pregunta sobre les dades",
    contexts: [0], // guild only, no DMs
    options: [{ name: "message", description: "La pregunta", type: 3, required: true }],
  },
];

for (const guild of guilds.split(",").map((s) => s.trim()).filter(Boolean)) {
  const res = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  console.log(`guild ${guild}: ${res.status} ${res.ok ? "ok" : await res.text()}`);
}

export {};
