# Self-Improving Memory Palace Framework

A self-improving AI agent with persistent structured memory, fact verification, and feedback-driven learning. Built with TypeScript, PostgreSQL + pgvector, Vercel AI SDK v6, and XState v5.

## Architecture

The agent is built around four core systems:

### 1. Memory Palace (Persistent Structured Memory)

Inspired by the [MemPalace](https://github.com/milla-jovovich/mempalace) architecture, memories are organized in a spatial hierarchy:

```
Palace
├── Wing (person/project)      e.g., "user:alice", "general:coding"
│   ├── Hall (memory type)     e.g., "facts", "corrections", "learnings"
│   │   └── Room (topic)       e.g., "redis", "typescript", "api-design"
│   │       └── Drawer          verbatim content + embedding
```

All data lives in PostgreSQL with pgvector — one database replaces both vector stores and knowledge graphs. A **4-layer loading system** keeps the context window efficient:

| Layer | Budget | When |
|-------|--------|------|
| L0 | ~100 tokens | Always (user identity + preferences) |
| L1 | ~800 tokens | Always (top memories by access frequency) |
| L2 | ~2000 tokens | On topic match (active rooms from context machine) |
| L3 | ~1000 tokens | On demand (semantic search for current query) |

### 2. Fact Verification (Truth Engine)

Every user message is classified. Factual claims are verified through a multi-step pipeline:

```
User claim → Extract claims → Check memory → Exa web search → LLM evaluate → Store verdict
```

The agent never blindly agrees with the user. If you say "the sky is pink," it searches, finds no evidence, and politely corrects you.

### 3. Feedback Learning (`/good` and `/bad`)

Feedback triggers a background self-reflection loop:

**`/good`** — Analyzes what worked (style, accuracy, depth), extracts repeatable patterns, stores them in the relevant topic room, and boosts user preference confidence.

**`/bad [correction]`** — Classifies the error type, researches via Exa if factual, generates a corrected answer with root cause analysis and avoidance rules, stores the correction in the topic-specific room (not a flat bucket), and updates the knowledge graph for affected entities.

Corrections are **topic-routed**: a mistake about Redis goes into `general:databases/corrections/redis`, not a generic "mistakes" pile. When the topic comes up again, past corrections are loaded into context automatically.

### 4. Active Context Management

An XState state machine tracks which "rooms" are loaded into context:

- New topics detected → rooms loaded at 0.80 relevance
- Each turn without mention → relevance decays by 15%
- Below 0.20 threshold → room unloaded
- Hard token budget enforced (drops lowest relevance first)

This means the agent dynamically adapts its memory to the conversation flow without blowing up the context window.

## How the Agent Learns

```
Turn 1: User asks "What is Redis?"
        → Agent answers (maybe too generic)

Turn 2: User types "/bad Redis is primarily an in-memory data store, not just a database"
        → Background: Agent analyzes error → researches Redis → generates corrected answer
        → Stores correction in general:databases/corrections/redis
        → Stores avoidance rule: "When describing Redis, lead with in-memory data store"

Turn 3: User asks "What is Redis?" again
        → L2 loads corrections from the redis room
        → System prompt includes: "Past correction: describe Redis as in-memory data store first"
        → Agent gives improved answer

Turn 4: User types "/good"
        → Agent learns: "accurate_facts, one-sentence-per-concept format worked"
        → Stores positive pattern in the redis room
        → Boosts user preference for concise answers
```

## Conversation Memory

Every exchange is automatically saved in the background — no `/save` command needed:

1. **Raw messages** stored with embeddings in the `messages` table
2. **Topic-tagged drawers** stored in the palace under the relevant room
3. **Rolling summary** generated after each exchange — a compact narrative of the conversation so far, updated in-place (not duplicated)

On the next session, recent conversation summaries are loaded as "warm" context in the L1 layer. The agent can recall past conversations by searching the palace (`wing='conversations'`, `hall='summaries'`).

### Unified Palace Structure

Everything lives in one place — conversations, corrections, learnings, facts:

```
Palace
├── conversations/summaries/{id}           ← rolling conversation summaries
├── user:{id}/conversations/{topic}        ← raw exchanges by topic
├── system/facts/verified                  ← fact-checked claims
├── system/identity                        ← agent + user identity (L0)
├── {wing}/learnings/{room}                ← what worked (/good patterns)
├── {wing}/corrections/{room}              ← what went wrong (/bad corrections)
└── system/learnings/universal_patterns    ← cross-topic style rules
```

One tool (`searchMemory`) searches all of it. Filter by `wing` and `hall` to narrow scope.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Database | Neon (PostgreSQL) + pgvector |
| ORM | Drizzle |
| LLM Framework | Vercel AI SDK v6 |
| State Machines | XState v5 |
| Embeddings | Gemini embedding-001 (3072 dim) |
| Web Search | Exa |
| Language | TypeScript |

The agent is **model-agnostic** — configure via environment variables:
```
MAIN_MODEL=google:gemini-2.5-pro       # or anthropic:claude-sonnet-4-20250514, openai:gpt-4o
FAST_MODEL=google:gemini-2.0-flash     # for classification, preference detection
```

## Setup

### Prerequisites

- Node.js 20+
- A [Neon](https://neon.tech) database (free tier works)
- Google API key (for Gemini embeddings)
- Exa API key (for web search)

### Install

```bash
git clone https://github.com/naurunnahansa/SelfImprovingMemPalaceFramework.git
cd SelfImprovingMemPalaceFramework
pnpm install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your credentials:
#   DATABASE_URL    — Neon connection string
#   GOOGLE_API_KEY  — Gemini API key
#   EXA_API_KEY     — Exa search key
#   MAIN_MODEL      — LLM for responses (e.g., google:gemini-2.5-pro)
#   FAST_MODEL      — LLM for classification (e.g., google:gemini-2.0-flash)
```

### Create Database Tables

```bash
pnpm db:generate    # Generate migration SQL
pnpm db:migrate     # Run migrations (creates 9 tables + pgvector extension)
```

### Verify Setup

```bash
npx tsx src/smoke-test.ts    # Tests DB connection, embeddings, storage, and search
```

### Run

```bash
pnpm dev            # Interactive CLI
```

Commands:
- `/good` — Mark last response as good (learns in background)
- `/bad [correction]` — Mark last response as bad (researches + corrects in background)
- `/rooms` — Show active context rooms and relevance scores
- `/quit` — Exit

### Run Demo

```bash
npx tsx src/demo.ts    # Shows the full learning loop
```

## Database Schema

9 tables in PostgreSQL:

- **drawers** — Memory chunks with wing/hall/room spatial tags + 3072-dim vector embeddings
- **entities** — Knowledge graph nodes (people, projects, concepts)
- **triples** — Temporal relationships with `valid_from`/`valid_to` for point-in-time queries
- **verified_facts** — Fact-checked claims with sources, verdict, and confidence scores
- **users** — User profiles
- **user_preferences** — Learned preferences with confidence scoring (decays/grows with signals)
- **feedback** — Full feedback records with error classification and resolution
- **conversations** / **messages** — Conversation history with embeddings

## Benchmark Results

Tested against [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025), the standard benchmark for long-term memory in chat assistants:

| Metric | Our System | MemPalace (raw) |
|--------|-----------|-----------------|
| Recall@5 | 90.0% | 96.6% |
| Recall@10 | 90.0% | 98.2% |
| NDCG@10 | 0.838 | 0.889 |

Tested on 20-question subset using raw Gemini embeddings + cosine similarity, no hybrid reranking. The full benchmark runner is included at `benchmarks/longmemeval.ts`.

## Project Structure

```
src/
├── index.ts                    # CLI REPL
├── demo.ts                     # Demo script showing learning loop
├── config.ts                   # Model-agnostic LLM config
├── db/
│   ├── schema.ts               # 9-table Drizzle schema
│   ├── client.ts               # Neon serverless + Drizzle
│   └── migrate.ts              # Migration runner
├── palace/
│   ├── store.ts                # Drawer CRUD (SHA-256 idempotent upserts)
│   ├── search.ts               # Vector + keyword + hybrid search (RRF)
│   ├── layers.ts               # L0-L3 loading with token budgets
│   └── graph.ts                # Knowledge graph (temporal triples, BFS)
├── machines/
│   ├── context.machine.ts      # Topic tracking, room load/unload, decay
│   ├── factcheck.machine.ts    # Claim → verify → store pipeline
│   └── feedback.machine.ts     # /good and /bad learning loops
├── agent/
│   ├── agent.ts                # Main orchestration
│   ├── tools.ts                # 6 AI SDK tools
│   ├── prompts.ts              # Dynamic system prompt from memory layers
│   └── classifier.ts           # Message topic/claim extraction
├── embeddings/gemini.ts        # Gemini embedding client
├── search/exa.ts               # Exa web search client
└── preferences/
    ├── detector.ts             # Passive preference detection
    └── model.ts                # Preference CRUD with confidence blending
```

## Possible Improvements

- **Hybrid search in benchmarks** — Adding keyword + vector fusion (already implemented in the agent) to the benchmark runner should close the gap with MemPalace
- **Better error classification** — The feedback LLM sometimes misclassifies "correct but incomplete" as style issues rather than factual gaps
- **Streaming responses** — Switch from `generateText` to `streamText` for real-time output
- **HTTP API** — Add Express/Hono endpoints for frontend integration
- **Multi-user isolation** — Each user already has their own preference model; extend to per-user palace wings
- **Conversation summarization** — Compress old conversations into summaries to reduce L1 token usage over time
