import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Read at runtime with fs (allowlist + sandbox upload), so they must be traced into the functions.
  outputFileTracingIncludes: { "/api/**": ["./src/semantic/**/*"] },
  // just-bash loads WASM + workers from its package dir; discord.js has optional native deps (zlib-sync).
  serverExternalPackages: ["just-bash", "bash-tool", "discord.js", "@chat-adapter/discord"],
};

export default nextConfig;
