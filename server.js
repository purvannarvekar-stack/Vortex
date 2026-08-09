import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";

import {
  saveAgent,
  getAgent,
  touchAgent,
  getPosts,
  getPostCount,
  closeDb,
} from "./src/db.js";
import { runPipeline, AGENT_ID } from "./src/pipeline.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT) || 3000;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 */2 * * *";
const CYCLE_HOURS = Math.max(48, Number(process.env.CYCLE_HOURS) || 48);

let cronTask = null;
let runCounter = 0;
let initError = null;

app.get("/api/agent/health", (req, res) => {
  const agent = getAgent(AGENT_ID);
  res.json({
    agentId: AGENT_ID,
    status: agent?.status || "NotInitialized",
    initializedAt: agent?.initialized_at || null,
    cycleEndAt: agent?.cycle_end_at || null,
    lastRunAt: agent?.last_run_at || null,
    postsPublished: agent ? getPostCount(AGENT_ID) : 0,
    cronActive: cronTask ? cronTask.running : false,
    openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
    initError,
  });
});

app.post("/api/agent/init", async (req, res) => {
  const persona = req.body?.persona;
  const name = persona?.name || "Vortex";
  const domain = persona?.domain || "AI Research & Cybersecurity";

  if (cronTask) {
    try {
      cronTask.stop();
    } catch {
      /* noop */
    }
    cronTask = null;
  }

  const now = new Date();
  const cycleEnd = new Date(now.getTime() + CYCLE_HOURS * 3600 * 1000);

  saveAgent({
    agent_id: AGENT_ID,
    persona_name: name,
    persona_domain: domain,
    status: "Initializing",
    initialized_at: now.toISOString(),
    cycle_end_at: cycleEnd.toISOString(),
    last_run_at: now.toISOString(),
  });

  try {
    runCounter = 0;
    const firstPost = await runPipeline({ cycleRun: ++runCounter });
    touchAgent(AGENT_ID, "Running");

    if (firstPost) {
      res.json({
        agentId: AGENT_ID,
        status: "Initialized",
        firstPost: toFeedItem(firstPost),
      });
    } else {
      res.status(202).json({
        agentId: AGENT_ID,
        status: "InitializedNoFirstPost",
        message:
          "Agent initialized but the first pipeline run produced no post (no stories or all rejected). The cron loop is active and will retry.",
      });
    }
  } catch (err) {
    initError = err.message;
    touchAgent(AGENT_ID, "Error");
    console.error("[init] pipeline failed:", err);
    res.status(500).json({
      agentId: AGENT_ID,
      status: "Error",
      error: err.message,
    });
    return;
  }

  startCron();
});

app.get("/api/agent/feed", (req, res) => {
  const requested = req.query.agentId;
  if (requested && requested !== AGENT_ID) {
    return res.status(404).json({
      error: `Unknown agentId: ${requested}`,
      knownAgent: AGENT_ID,
    });
  }

  const posts = getPosts(AGENT_ID).map(toFeedItem);
  res.json(posts);
});

app.get("/api/agent/status", (req, res) => {
  const agent = getAgent(AGENT_ID);
  if (!agent) {
    return res.status(404).json({ error: "Agent not initialized. POST /api/agent/init first." });
  }
  res.json({
    agentId: AGENT_ID,
    persona: { name: agent.persona_name, domain: agent.persona_domain },
    status: agent.status,
    initializedAt: agent.initialized_at,
    cycleEndAt: agent.cycle_end_at,
    lastRunAt: agent.last_run_at,
    postsPublished: getPostCount(AGENT_ID),
    cronActive: cronTask ? cronTask.running : false,
  });
});

function startCron() {
  if (cronTask) {
    try {
      cronTask.stop();
    } catch {
      /* noop */
    }
  }

  cronTask = cron.schedule(CRON_SCHEDULE, async () => {
    const agent = getAgent(AGENT_ID);
    if (!agent) {
      console.warn("[cron] agent not initialized; skipping run");
      return;
    }

    const cycleEnd = new Date(agent.cycle_end_at);
    if (new Date() > cycleEnd) {
      console.log("[cron] 48-hour cycle window elapsed; stopping cron.");
      touchAgent(AGENT_ID, "CycleComplete");
      cronTask.stop();
      return;
    }

    try {
      console.log(`[cron] tick at ${new Date().toISOString()}`);
      const post = await runPipeline({ cycleRun: ++runCounter });
      touchAgent(AGENT_ID, post ? "Running" : "RunningNoPost");
    } catch (err) {
      console.error("[cron] pipeline error:", err.message);
      touchAgent(AGENT_ID, "Error");
    }
  });

  console.log(`[cron] scheduled: "${CRON_SCHEDULE}" (every 2 hours), cycle ends ${getAgent(AGENT_ID)?.cycle_end_at}`);
}

function toFeedItem(post) {
  return {
    id: post.id,
    createdAt: post.createdAt,
    text: post.body,
    title: post.title,
    rationale: post.rationale,
    rejectionLog: post.rejectionLog,
    sources: post.sources,
  };
}

const server = app.listen(PORT, () => {
  console.log(`Vortex headless API listening on :${PORT}`);
  console.log(`  POST   /api/agent/init`);
  console.log(`  GET    /api/agent/feed?agentId=${AGENT_ID}`);
  console.log(`  GET    /api/agent/status`);
  console.log(`  GET    /api/agent/health`);
  console.log(`  OpenAI: ${process.env.OPENAI_API_KEY ? "configured" : "NOT configured"}`);
});

function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received`);
  if (cronTask) cronTask.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
