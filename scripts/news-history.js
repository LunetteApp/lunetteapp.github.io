const fs = require("fs");
const path = require("path");
const {
  canonicalNewsURL,
  writeFileAtomically
} = require("./news-utils");

const ROOT = path.resolve(__dirname, "..");
const HISTORY_PATH = path.join(ROOT, "data", "old_articles.json");
const HISTORY_VERSION = 1;

function emptyHistory() {
  return {
    version: HISTORY_VERSION,
    articles: {}
  };
}

function readArticleHistory(filePath = HISTORY_PATH) {
  try {
    const history = JSON.parse(fs.readFileSync(filePath, "utf8"));
    validateArticleHistory(history);
    return { history, existed: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { history: emptyHistory(), existed: false };
    }
    throw error;
  }
}

function validateArticleHistory(history) {
  if (!history || typeof history !== "object" || Array.isArray(history)) {
    throw new Error("old_articles.json must contain an object");
  }
  if (history.version !== HISTORY_VERSION) {
    throw new Error(`Unsupported old_articles.json version: ${history.version}`);
  }
  if (!history.articles || typeof history.articles !== "object"
      || Array.isArray(history.articles)) {
    throw new Error("old_articles.json must contain an articles object");
  }
  for (const [canonicalURL, record] of Object.entries(history.articles)) {
    if (!canonicalURL || !record || typeof record !== "object" || !record.url) {
      throw new Error(`Invalid article-history record for ${canonicalURL || "unknown URL"}`);
    }
    if (canonicalNewsURL(record.url) !== canonicalURL) {
      throw new Error(`Article-history key does not match its URL: ${canonicalURL}`);
    }
    if (typeof record.title !== "string" || typeof record.lang !== "string") {
      throw new Error(`Article-history record has invalid title or language: ${canonicalURL}`);
    }
    if (!validISODate(record.first_seen_at)) {
      throw new Error(`Article-history record has invalid first_seen_at: ${canonicalURL}`);
    }
    if (record.published_at !== null && !validISODate(record.published_at)) {
      throw new Error(`Article-history record has invalid published_at: ${canonicalURL}`);
    }
    for (const flag of [
      "marketing",
      "scoring_pending",
      "clustering_pending",
      "skip_image_lookup",
      "skip_reading_time_lookup"
    ]) {
      if (Object.hasOwn(record, flag) && typeof record[flag] !== "boolean") {
        throw new Error(`Article-history record has invalid ${flag}: ${canonicalURL}`);
      }
    }
  }
}

function historyRecord(history, url) {
  return history.articles[canonicalNewsURL(url)] ?? null;
}

function upsertHistoryRecord(
  history,
  article,
  seenAt,
  { bootstrap = false } = {}
) {
  const key = canonicalNewsURL(article?.url);
  if (!key) return null;
  const existing = history.articles[key] ?? {};
  const publishedAt = validISODate(article?.published_at);
  const firstSeenAt = existing.first_seen_at
    ?? (bootstrap && publishedAt ? publishedAt : validISODate(seenAt))
    ?? new Date().toISOString();
  const record = {
    ...existing,
    url: String(article.url),
    title: String(article.title || existing.title || ""),
    lang: String(article.lang || existing.lang || "und"),
    published_at: publishedAt ?? existing.published_at ?? null,
    first_seen_at: firstSeenAt
  };
  history.articles[key] = record;
  return record;
}

function writeArticleHistory(history, filePath = HISTORY_PATH) {
  validateArticleHistory(history);
  const ordered = {
    version: HISTORY_VERSION,
    articles: Object.fromEntries(
      Object.entries(history.articles).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    )
  };
  writeFileAtomically(filePath, `${JSON.stringify(ordered, null, 2)}\n`);
}

function validISODate(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function hostnameForURL(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function publicationRateForHosts(history, hostnames, now = new Date(), days = 30) {
  const hosts = new Set([...hostnames].map((host) => String(host).toLowerCase()).filter(Boolean));
  if (hosts.size === 0) return 0;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1_000;
  const count = Object.values(history.articles).filter((record) => {
    const firstSeen = Date.parse(record?.first_seen_at || "");
    return Number.isFinite(firstSeen)
      && firstSeen >= cutoff
      && firstSeen <= now.getTime()
      && hosts.has(hostnameForURL(record.url));
  }).length;
  return count / days;
}

module.exports = {
  HISTORY_PATH,
  emptyHistory,
  historyRecord,
  hostnameForURL,
  publicationRateForHosts,
  readArticleHistory,
  upsertHistoryRecord,
  validateArticleHistory,
  writeArticleHistory
};
