# OSS Data Analyst

Discord bot that answers natural-language questions about Goil data. An AI agent explores a semantic layer (YAML), builds read-only MongoDB queries (business data) and HogQL queries against PostHog (backoffice and help center usage) and explains the results in plain language. Forked from [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst).

## How it works

```
Discord /ask message:<question>
  → /api/webhooks/discord (HTTP Interactions, Chat SDK)
  → agent (AI SDK 7, openai/gpt-5.6-luna via AI Gateway)
      bash           just-bash, in-process: semantic/ YAML, /tmp/mongo_schema.txt,
                     /tmp/mongodb_result.{json,csv} (jq, xan, sqlite3, python3 stdlib; no network)
      ExecuteMongoDB read-only queries, guarded (see below)
      ExecutePostHog HogQL on PostHog, only if POSTHOG_API_KEY is set (query:read key)
      FinalizeReport narrative posted back to the channel
```

Query tools return the row count and a 50-row preview to the model; the full result (max 1000 rows) goes to the sandbox files for analysis. Instructions are static (date in a separate block) with AI Gateway automatic prompt caching, so each step only pays for new tokens.

Each `/ask` is independent (no conversation memory). Mentions would need the Discord Gateway (a permanently running listener), deliberately left out.

## Security

- **Access**: only servers in `DISCORD_ALLOWED_GUILD_IDS` (empty = nobody, DMs never). Webhooks are verified with `DISCORD_PUBLIC_KEY`. Restrict `/ask` to roles/channels in Discord (Server Settings > Integrations). There is no web UI.
- **Read-only**: in production the app refuses to start queries if the MongoDB user has write privileges or is unauthenticated. Use a user with only the `read`/`readAnyDatabase` role. On top of that, `src/lib/query-guard.ts` rejects `$out`/`$merge`, server-side JS (`$where`, `$function`, `$accumulator`) and introspection stages; queries have `maxTimeMS` and row caps and go to secondaries.
- **Allowlist**: only databases/collections in `src/semantic/databases.yml` can be queried (including `$lookup`/`$unionWith` targets).
- **Personal data**: queries referencing PII fields (defaults in `query-guard.ts`, extend with `PII_FIELDS`) are rejected anywhere in the query, `$objectToArray`/`$getField` are blocked, and any PII-named key left in results is redacted before it reaches the model, the sandbox, traces or Discord.

## Setup

1. `pnpm install` (Node 22+)
2. `cp .env.example .env` and fill it in.
3. Vercel: link the project, add the env vars (AI Gateway uses OIDC, no key needed), add a Redis store (e.g. Upstash from the Marketplace) for `REDIS_URL`. Enable Fluid compute (`maxDuration = 800`).
4. Discord Developer Portal: set **Interactions Endpoint URL** to `https://<prod-domain>/api/webhooks/discord`, invite the bot with `bot` + `applications.commands` scopes, then `pnpm register-commands` to register `/ask` in the allowed guilds.

## Development

```bash
pnpm ask "Quants comptes estan validats?"   # run the agent locally against MongoDB
pnpm test                                   # unit tests (query guard, result preview)
pnpm eval                                   # evalite evals (real MongoDB + model)
pnpm lint && pnpm type-check && pnpm build
```

Semantic layer: `src/semantic/databases.yml` (databases + collection allowlist), `catalog.yml` (entities), `entities/*.yml` (fields, lookups).

## License

MIT
