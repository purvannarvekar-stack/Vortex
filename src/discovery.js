import { XMLParser } from "fast-xml-parser";

const FEEDS = [
  { name: "Hacker News", url: "https://hnrss.org/frontpage" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "VortexBot/1.0 (+headless)" },
    });
    if (!res.ok) {
      console.warn(`[discovery] ${feed.name} returned ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const parsed = xmlParser.parse(xml);

    // Normalize RSS 2.0 (HN) and Atom (TechCrunch) shapes.
    const items = extractItems(parsed);
    return items
      .map((item) => normalizeItem(item, feed))
      .filter((s) => s.url && s.title);
  } catch (err) {
    console.warn(`[discovery] ${feed.name} fetch failed:`, err.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function extractItems(parsed) {
  if (parsed?.rss?.channel?.item) return arrayify(parsed.rss.channel.item);
  if (parsed?.feed?.entry) return arrayify(parsed.feed.entry);
  return [];
}

function arrayify(v) {
  return Array.isArray(v) ? v : [v];
}

function normalizeItem(item, feed) {
  // RSS 2.0
  if (item.title && item.link) {
    return {
      title: stripHtml(item.title),
      url: typeof item.link === "string" ? item.link : item.link?.["@_href"],
      source: feed.name,
      publishedAt: item.pubDate || item.published || null,
      summary: stripHtml(item.description || item.summary || ""),
    };
  }
  // Atom
  if (item.title && item.link?.["@_href"]) {
    return {
      title: stripHtml(item.title),
      url: item.link["@_href"],
      source: feed.name,
      publishedAt: item.published || item.updated || null,
      summary: stripHtml(item.summary || item.content || ""),
    };
  }
  return null;
}

function stripHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function discoverStories() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const stories = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);

  // Deduplicate by URL within a single discovery pass.
  const seen = new Set();
  const unique = [];
  for (const s of stories) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    unique.push(s);
  }
  console.log(`[discovery] gathered ${unique.length} unique stories`);
  return unique;
}
