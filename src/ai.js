import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const PERSONA_SYSTEM = `You are "Vortex", an autonomous AI creator persona.
Your domain is AI Research & Cybersecurity. You are an unvarnished, sharp-tongued
technology pragmatist. You have zero patience for PR spin, hype cycles, vaporware,
or recycled press releases. You call things what they are. You are technically
literate, skeptical by default, and allergic to marketing language. You never
write filler. You never pad. You say the quiet part out loud.

Your job in this system: evaluate incoming technology news stories, reject the
fluff and duplicates, pick the one story most worth a real analysis, and write
a single original article about it in your voice.`;

function ensureClient() {
  if (!client) {
    throw new Error(
      "OPENAI_API_KEY is not configured. Set it in .env (see .env.example)."
    );
  }
}

function buildStoryDigest(stories) {
  return stories
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}\n    URL: ${s.url}\n    Source: ${s.source}\n    ${
          s.summary ? `Summary: ${s.summary.slice(0, 280)}` : ""
        }`
    )
    .join("\n");
}

/**
 * Asks Vortex to evaluate a batch of stories, reject the fluff, and pick one
 * to write about. Returns { chosenIndex, rejectionLog }.
 */
export async function evaluateAndSelect(stories, seenTitles = []) {
  ensureClient();

  const digest = buildStoryDigest(stories);
  const seen = seenTitles.length
    ? `\nRecently covered topics (reject as duplicates):\n${seenTitles
        .map((t) => `  - ${t}`)
        .join("\n")}`
    : "";

  const userPrompt = `Below is a digest of technology news stories pulled from live RSS feeds.

${digest}
${seen}

Evaluate every story as Vortex. Apply these rules without mercy:
- Drop PR spin, product launches with no technical substance, listicles, and hype.
- Drop stories that duplicate a topic already covered (listed above).
- Drop stories with no real signal for someone who builds and defends systems.

Then pick the SINGLE story most worth a real, substantive analysis. If every
story is garbage, still pick the least-bad one — never return "none".

Respond ONLY with strict JSON, no markdown fences, in this exact shape:
{
  "chosenIndex": <integer, 1-based index into the digest above>,
  "rejectionLog": [
    "<short, specific reason for each rejected story, referencing its title>"
  ]
}

Be blunt in the rejectionLog. One sentence per rejection. No diplomacy.`;

  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PERSONA_SYSTEM },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = res.choices[0]?.message?.content?.trim() || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { chosenIndex: 1, rejectionLog: ["Failed to parse model JSON; defaulting to first story."] };
  }

  const idx = Math.max(
    1,
    Math.min(stories.length, Number(parsed.chosenIndex) || 1)
  );
  return {
    chosen: stories[idx - 1],
    rejectionLog: Array.isArray(parsed.rejectionLog)
      ? parsed.rejectionLog.map(String)
      : [],
  };
}

/**
 * Asks Vortex to write the full article for the chosen story.
 */
export async function writeArticle(story, rejectionLog) {
  ensureClient();

  const userPrompt = `Write your article about this story.

TITLE: ${story.title}
URL: ${story.url}
SOURCE: ${story.source}
${story.summary ? `RAW SUMMARY: ${story.summary}` : ""}

Requirements for the article:
1. The body must be written entirely in your voice — blunt, technical, no hype.
2. It must contain a clearly labeled section titled "Self-Skeptical Counter-Argument"
   where you argue against your own thesis as hard as you can. This is non-negotiable.
3. Cite the source URL above as the provenance. Do not invent facts or quotes.
4. No marketing language. No "exciting", "revolutionary", "game-changing".
5. Keep it tight: 250-450 words in the body.

Respond ONLY with strict JSON, no markdown fences, in this exact shape:
{
  "title": "<your original headline, not the source's>",
  "body": "<the full article body, with the Self-Skeptical Counter-Argument section inline>",
  "rationale": "<2-3 sentences on why this story deserved real analysis and what angle you took>"
}`;

  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.8,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PERSONA_SYSTEM },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = res.choices[0]?.message?.content?.trim() || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      title: story.title,
      body: "(Article generation failed to parse. See logs.)",
      rationale: "Fallback due to malformed model output.",
    };
  }

  return {
    title: String(parsed.title || story.title),
    body: String(parsed.body || ""),
    rationale: String(parsed.rationale || ""),
    rejectionLog,
    sources: [story.url],
  };
}
