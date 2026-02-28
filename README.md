# OSS Data Analyst

An AI data analyst agent that explores a semantic layer in a sandboxed Docker environment to answer natural language questions with MongoDB queries and Python analysis.

## Overview

OSS Data Analyst uses a sandboxed exploration approach: instead of hardcoding schema knowledge into prompts, the agent is given shell access to a Docker container containing your semantic layer files. It discovers the schema dynamically using `cat`, `grep`, and `ls` commands, then builds and executes MongoDB queries based on what it finds.

This architecture means the agent can:
- Adapt to any schema without prompt changes
- Explore relationships between entities naturally
- Handle schema updates without redeployment
- Reason about data the same way a human analyst would
- Run Python analysis with pandas, numpy, scipy alongside queries

## How It Works

1. **Sandbox Creation** - A persistent Docker container is started with your semantic layer YAML files mounted read-only
2. **Schema Exploration** - The agent uses shell commands to browse the catalog and entity definitions
3. **Query Building** - Based on discovered schema, the agent constructs MongoDB queries (find or aggregation)
4. **Execution** - Queries run on the host via the Node.js MongoDB driver; results are auto-written to `/tmp/mongodb_result.{json,csv}` inside the container for Python analysis
5. **Reporting** - Results are formatted with a plain-language narrative

```
User Question
     ↓
┌──────────── Host (Node.js) ─────────────┐
│  ExecuteMongoDB tool                     │
│    → Node.js MongoDB driver             │
│    → results auto-written to container  │
└──────────────────────────────────────────┘
     ↓
┌──────────── Docker Sandbox ─────────────┐
│  semantic/                               │
│  ├── databases.yml                      │
│  ├── catalog.yml                        │
│  └── entities/*.yml                     │
│                                          │
│  /tmp/mongodb_result.json  (auto)       │
│  /tmp/mongodb_result.csv   (auto)       │
│                                          │
│  Agent explores with:                    │
│  • cat semantic/catalog.yml             │
│  • grep -r "keyword" semantic/          │
│  • python3 + pandas on result files     │
└──────────────────────────────────────────┘
     ↓
Results → Narrative
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm
- Docker Desktop (running)
- MongoDB (local or Atlas)
- Redis (for Discord integration - e.g., Upstash)

### Installation

```bash
git clone https://github.com/vercel-labs/oss-data-analyst.git
cd oss-data-analyst
pnpm install
```

### Configuration

```bash
cp .env.example .env.local
```

Add your `MONGODB_URI` and other keys to `.env.local`.

For local MongoDB:
```
MONGODB_URI=mongodb://localhost:27017/oss-data-analyst
```

For MongoDB Atlas:
```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/oss-data-analyst?retryWrites=true&w=majority
```

For multiple databases:
```
MONGODB_DATABASES=AnalyticsDB,ClientDB
```

### Test Connection

```bash
pnpm testMongo
```

Verifies MongoDB connectivity and lists collections.

### Run

```bash
pnpm dev
```

Open http://localhost:3000

On first run, the sandbox container (`data-analyst-sandbox`) is created and Python dependencies are installed automatically. This takes ~30 seconds once; subsequent starts reuse the container.

## Docker Sandbox

Shell exploration and Python analysis happen inside a persistent `ubuntu:22.04` Docker container named `data-analyst-sandbox`. MongoDB queries run on the host via the Node.js driver (no database credentials enter the container).

**Volume mounts (read-only):**
- `src/semantic/` → `/app/semantic` — schema YAML files

**Pre-installed Python packages:** `pandas`, `numpy`, `scipy`

**Auto-written result files:** After each `ExecuteMongoDB` query, results are piped into the container via base64:
- `/tmp/mongodb_result.json` — full JSON array of rows
- `/tmp/mongodb_result.csv` — CSV with headers, ready for `pd.read_csv()`

Query execution flow:
```
ExecuteMongoDB tool → Node.js MongoDB driver (host)
  → rows/columns returned to model
  → results base64-piped into container as /tmp/mongodb_result.{json,csv}
  → agent can run: python3 -c "import pandas as pd; df = pd.read_csv('/tmp/mongodb_result.csv')"
```

## Discord Integration

The bot can be accessed via Discord using the Vercel Chat SDK.

### Setup

1. Create a Discord application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Go to "Bot" and create a bot, copy the token
3. Go to "General Information" and copy "Application ID" and "Public Key"
4. Under "Interactions Endpoint URL", set: `https://your-domain.com/api/webhooks/discord`
5. Add these env vars to `.env.local`:
   ```
   DISCORD_BOT_TOKEN=your-bot-token
   DISCORD_PUBLIC_KEY=your-public-key
   DISCORD_APPLICATION_ID=your-application-id
   REDIS_URL=redis://your-redis-instance
   CRON_SECRET=a-random-secret-string
   ```
6. Invite bot to server with URL: `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=2048&scope=bot%20applications.commands`

### Usage

- @mention the bot in any channel to ask a question
- The bot will respond with data analysis results in plain language

## Semantic Layer

The semantic layer lives in `src/semantic/` and defines your data model:

```
src/semantic/
├── databases.yml         # Database catalog (list all DBs and their collections)
├── catalog.yml           # Entity index with descriptions
└── entities/
    └── *.yml             # One file per entity with fields, lookups, examples
```

Each entity YAML includes:
- `collection` - The underlying MongoDB collection
- `database` - Which database this entity lives in
- `fields` - Available document fields
- `lookups` - Relationships to other entities ($lookup)
- Example questions the entity can answer

The agent reads these files at runtime to understand your schema.

## Key Files

- `src/lib/agent.ts` — Agent definition and system prompt
- `src/lib/tools/sandbox.ts` — Docker container creation, Python setup, exec helper
- `src/lib/tools/shell.ts` — Bash tool for schema exploration
- `src/lib/tools/execute-mongodb.ts` — MongoDB tool (executes on host via Node.js driver)
- `src/lib/mongodb.ts` — MongoDB client and query execution (find + aggregation)
- `src/lib/database-registry.ts` — Multi-database configuration from env vars

## Adding Your Own Schema

1. Add entity YAML files to `src/semantic/entities/`
2. Update `src/semantic/catalog.yml` with the new entity
3. Update `src/semantic/databases.yml` if adding a new database
4. The agent will automatically discover and use the new schema

No code changes required — the sandbox approach means schema changes are picked up at runtime.

## Troubleshooting

**Connection Failed**
```bash
pnpm testMongo
```

**Python not found on first query**
The sandbox installs Python on container creation. If you hit this on a pre-existing container, restart — it will detect missing Python and reinstall automatically.

**Build Errors**
```bash
pnpm type-check
```

**Inspect the running container**
```bash
docker inspect data-analyst-sandbox   # check env vars and mounts
docker logs data-analyst-sandbox      # check init output
docker exec -it data-analyst-sandbox bash  # interactive shell
```
