# OSS Data Analyst

An AI data analyst agent that explores a semantic layer in a sandbox environment to answer natural language questions with SQL.

## Overview

OSS Data Analyst uses a sandboxed exploration approach: instead of hardcoding schema knowledge into prompts, the agent is given shell access to a sandbox containing your semantic layer files. It discovers the schema dynamically using `cat`, `grep`, and `ls` commands, then builds and executes SQL queries based on what it finds.

This architecture means the agent can:
- Adapt to any schema without prompt changes
- Explore relationships between entities naturally
- Handle schema updates without redeployment
- Reason about data the same way a human analyst would

## How It Works

1. **Sandbox Creation** - A Vercel Sandbox is spun up and populated with your semantic layer YAML files
2. **Schema Exploration** - The agent uses shell commands to browse the catalog and entity definitions
3. **Query Building** - Based on discovered schema, the agent constructs SQL queries
4. **Execution** - Queries run against your SQLite database
5. **Reporting** - Results are formatted with a narrative explanation

```
User Question
     ↓
┌─────────────────────────────────────┐
│           Vercel Sandbox            │
│  ┌─────────────────────────────┐   │
│  │  semantic/                   │   │
│  │  ├── catalog.yml            │   │
│  │  └── entities/              │   │
│  │      ├── companies.yml      │   │
│  │      ├── people.yml         │   │
│  │      └── accounts.yml       │   │
│  └─────────────────────────────┘   │
│                                     │
│  Agent explores with:               │
│  • cat semantic/catalog.yml         │
│  • grep -r "keyword" semantic/      │
│  • cat semantic/entities/*.yml      │
└─────────────────────────────────────┘
     ↓
SQL Query → Database → Results → Narrative
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm
- Vercel AI Gateway API key

### Installation

```bash
git clone https://github.com/vercel-labs/oss-data-analyst.git
cd oss-data-analyst
pnpm install
```

### Configuration

```bash
cp env.local.example .env.local
```

Add your Vercel AI Gateway key to `.env.local`.

### Initialize Database

```bash
pnpm initDatabase
```

Creates a SQLite database with sample data (Companies, People, Accounts).

### Run

```bash
pnpm dev
```

Open http://localhost:3000

## Semantic Layer

The semantic layer lives in `src/semantic/` and defines your data model:

```
src/semantic/
├── catalog.yml           # Entity index with descriptions
└── entities/
    ├── companies.yml     # Company entity definition
    ├── people.yml        # People entity definition
    └── accounts.yml      # Accounts entity definition
```

Each entity YAML includes:
- `sql_table_name` - The underlying table
- `fields` - Available columns with SQL expressions
- `joins` - Relationships to other entities
- Example questions the entity can answer

The agent reads these files at runtime to understand your schema.

## Example Questions

- "How many companies are in the Technology industry?"
- "What is the average salary by department?"
- "Show me the top 5 accounts by monthly value"
- "Which companies have the most employees?"

## Architecture

**Stack**: Next.js, Vercel AI SDK, Vercel Sandbox, SQLite

**Key Files**:
- `src/lib/agent.ts` - Agent definition and system prompt
- `src/lib/tools/sandbox.ts` - Sandbox creation with semantic files
- `src/lib/tools/shell.ts` - Shell command tool for exploration
- `src/lib/tools/execute-sqlite.ts` - SQL execution tool

## Adding Your Own Schema

1. Add entity YAML files to `src/semantic/entities/`
2. Update `src/semantic/catalog.yml` with the new entity
3. The agent will automatically discover and use the new schema

No code changes required—the sandbox approach means schema changes are picked up at runtime.

## Troubleshooting

**Database Not Found**
```bash
pnpm initDatabase
```

**Build Errors**
```bash
pnpm type-check
```
