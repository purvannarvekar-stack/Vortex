import { randomBytes } from "node:crypto";
import {
  savePost,
  markSeenStories,
  getSeenUrls,
  getPosts,
} from "./db.js";
import { discoverStories } from "./discovery.js";
import { evaluateAndSelect, writeArticle } from "./ai.js";

const AGENT_ID = "Vortex-Backend";

/**
 * Runs the full discovery -> editorial -> publishing pipeline once.
 * Returns the published post, or null if nothing could be produced.
 */
export async function runPipeline({ cycleRun = 0 } = {}) {
  console.log(`[pipeline] run #${cycleRun} starting`);

  const stories = await discoverStories();
  if (stories.length === 0) {
    console.warn("[pipeline] no stories discovered; aborting run");
    return null;
  }

  // Filter out stories we've already covered (by URL).
  const seenUrls = getSeenUrls(AGENT_ID);
  const fresh = stories.filter((s) => !seenUrls.has(s.url));

  if (fresh.length === 0) {
    console.warn("[pipeline] all discovered stories already seen; aborting run");
    return null;
  }

  // Give Vortex the recently covered titles so it can reject topical duplicates.
  const recent = getPosts(AGENT_ID).slice(0, 12).map((p) => p.title);

  const { chosen, rejectionLog } = await evaluateAndSelect(fresh, recent);
  if (!chosen) {
    console.warn("[pipeline] no story chosen; aborting run");
    return null;
  }

  const article = await writeArticle(chosen, rejectionLog);

  const post = {
    id: `post_${Date.now()}_${randomBytes(4).toString("hex")}`,
    agentId: AGENT_ID,
    title: article.title,
    body: article.body,
    rationale: article.rationale,
    rejectionLog: article.rejectionLog,
    sources: article.sources,
    createdAt: new Date().toISOString(),
    cycleRun,
  };

  savePost(post);
  markSeenStories(AGENT_ID, fresh);
  console.log(`[pipeline] published post ${post.id}: "${post.title}"`);
  return post;
}

export { AGENT_ID };
