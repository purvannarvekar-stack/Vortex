# Vortex — Vibe-Coding Architecture & Prompt Engineering

This document captures the prompt-engineering techniques and the "vibe-coding"
architecture behind the Vortex Autonomous AI Creator backend.

---

## 1. Architecture Overview

Vortex is a **headless** REST API. There is no UI. External evaluators and
clients interact exclusively through JSON endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/agent/init` | Initialize the persona and return the first generated article |
| `GET`  | `/api/agent/feed?agentId=Vortex-Backend` | Reverse-chronological feed of all published posts |
| `GET`  | `/api/agent/status` | Agent lifecycle status |
| `GET`  | `/api/agent/health` | Liveness + config probe |

### Pipeline (runs on init and every 2 hours via `node-cron`)

```
RSS Discovery (HN + TechCrunch)
        │
        ▼
Dedup vs. SQLite `seen_stories` table
        │
        ▼
Vortex editorial evaluation (OpenAI gpt-4o-mini)
   → picks ONE story, emits rejection_log
        │
        ▼
Vortex article generation (OpenAI gpt-4o-mini)
   → title, body (with Self-Skeptical Counter-Argument), rationale
        │
        ▼
Persist to SQLite `posts` table → exposed via /feed
```

### Persistence

- **`better-sqlite3`** (synchronous, fast, zero-config) stores:
  - `posts` — every published article.
  - `agent_state` — persona, status, init timestamp, 48h cycle end.
  - `seen_stories` — URL-level dedup so Vortex never repeats itself.

---

## 2. Prompt Engineering Techniques

### 2.1 Persona Anchoring (System Prompt)

The system prompt (`PERSONA_SYSTEM` in `src/ai.js`) does the heavy lifting. It
establishes Vortex as:

> *"an unvarnished, sharp-tongued technology pragmatist... zero patience for PR
> spin, hype cycles, vaporware... allergic to marketing language."*

Techniques used:
- **Identity framing** — a named persona with a stated worldview, not a generic
  "assistant". This biases tone and vocabulary before any user content arrives.
- **Negative constraints** — what *not* to do ("never write filler", "never
  pad") are as explicit as the positive ones. LLMs obey prohibitions better
  when they're stated as hard rules rather than implied.
- **Domain scoping** — "AI Research & Cybersecurity" keeps the persona from
  drifting into general tech blogging.

### 2.2 Two-Stage Decomposition

Rather than asking the model to evaluate stories *and* write an article in one
shot, the pipeline splits the work into two focused calls:

1. **`evaluateAndSelect`** — consume a digest, reject fluff, pick one story.
2. **`writeArticle`** — write the article for the chosen story only.

Why split:
- Each call has a single, testable responsibility.
- The rejection log is captured *before* generation, so it's a true editorial
  record, not a post-hoc rationalization.
- Smaller, focused prompts reduce the chance the model ignores instructions
  buried at the end.

### 2.3 Structured Output via `response_format: json_object`

Both OpenAI calls force JSON output. This makes the Node.js side deterministic:
no fragile regex scraping of prose. The expected schema is documented inline in
the prompt:

```json
{
  "chosenIndex": <int>,
  "rejectionLog": ["...", "..."]
}
```

```json
{
  "title": "...",
  "body": "...",
  "rationale": "..."
}
```

Each prompt states the exact shape and says *"Respond ONLY with strict JSON,
no markdown fences."* — the combination of instruction + `response_format` is
the most reliable way to get parseable structured output from gpt-4o-mini.

### 2.4 Forced Editorial Rejection

The evaluation prompt explicitly *forces* rejection behavior:

> *"Apply these rules without mercy: drop PR spin... drop duplicates... drop
> stories with no real signal..."*

It also forbids the "none" escape hatch:

> *"If every story is garbage, still pick the least-bad one — never return
> 'none'."*

This guarantees the pipeline always produces an article per run while still
generating a meaningful rejection log. Without this guardrail, the model would
frequently return `chosenIndex: null` on slow news days.

### 2.5 Duplicate-Aware Context

The pipeline passes the **titles of the last 12 published posts** into the
evaluation prompt as a "Recently covered topics" block. This gives the model
the context it needs to honor the "drop duplicates" rule across runs, not just
within a single discovery batch. Combined with URL-level dedup in SQLite, this
is a two-layer defense against topical repetition.

### 2.6 The Self-Skeptical Counter-Argument

The article-generation prompt mandates a labeled section:

> *"It must contain a clearly labeled section titled 'Self-Skeptical
> Counter-Argument' where you argue against your own thesis as hard as you
> can. This is non-negotiable."*

This is the signature editorial feature of Vortex. It:
- Forces intellectual honesty rather than one-sided takes.
- Is enforced as a hard structural requirement ("non-negotiable"), not a
  suggestion, so the model can't quietly omit it.
- Produces a recognizable artifact evaluators can grep for in the feed.

### 2.7 Tone Guardrails

The article prompt bans specific hype words:

> *"No marketing language. No 'exciting', 'revolutionary', 'game-changing'."*

Concrete forbidden tokens are more effective than abstract instructions like
"be objective". The persona system prompt reinforces this with the "allergic to
marketing language" framing.

### 2.8 Provenance Enforcement

> *"Cite the source URL above as the provenance. Do not invent facts or
> quotes."*

This keeps Vortex grounded in the real RSS story rather than hallucinating
details — critical for an autonomous system that publishes without human
review. The source URL is also stored independently in the `sources` array in
SQLite, so the feed always carries verifiable provenance even if the model
omits it from the body.

---

## 3. Vibe-Coding Principles Applied

- **One cohesive deliverable, end-to-end.** The server boots, initializes,
  generates, persists, and serves — no dead-end endpoints.
- **Fail loud, fail specific.** Every external call (RSS fetch, OpenAI) has a
  timeout and surfaces failures to the caller rather than silently returning
  empty data.
- **Idempotent init.** Calling `/init` again safely tears down the old cron
  task and starts fresh.
- **No UI by design.** Every state the evaluator needs is reachable via JSON.

---

## 4. Running

```bash
cp .env.example .env        # add your OPENAI_API_KEY
npm install
npm start
```

Then:

```bash
curl -X POST http://localhost:3000/api/agent/init \
  -H "Content-Type: application/json" \
  -d '{"persona":{"name":"Vortex","domain":"AI Research & Cybersecurity"}}'

curl "http://localhost:3000/api/agent/feed?agentId=Vortex-Backend"
```
