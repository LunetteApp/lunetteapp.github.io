const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "mc_cid",
  "mc_eid",
  "ref_src"
]);

function canonicalNewsURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return raw.replace(/#.*$/, "");
  }
}

function compactArticleID(url) {
  return `a_${crypto
    .createHash("sha256")
    .update(canonicalNewsURL(url))
    .digest("hex")
    .slice(0, 12)}`;
}

function singletonClusterID(article) {
  const timestamp = Date.parse(article?.published_at || "");
  const day = Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "")
    : "undated";
  const hash = crypto
    .createHash("sha256")
    .update(canonicalNewsURL(article?.url))
    .digest("hex")
    .slice(0, 12);
  return `${day}-${hash}`;
}

function isScore(value) {
  return value === -1
    || (Number.isInteger(value) && value >= 0 && value <= 100);
}

// Keep event age in article history, not news.json. A later write-up cannot
// create another notification window for the same event.
function normalizeEventNotifications(articles, now, history, maxAgeHours = 24) {
  const groups = new Map();
  for (const article of articles) {
    const key = article.cluster || canonicalNewsURL(article.url);
    const members = groups.get(key) ?? [];
    members.push(article);
    groups.set(key, members);
  }

  const cutoff = now.getTime() - maxAgeHours * 60 * 60 * 1_000;
  for (const [cluster, members] of groups) {
    const timestamps = members.flatMap((article) => {
      const record = history?.articles?.[canonicalNewsURL(article.url)];
      return [
        Date.parse(article.published_at || ""),
        record?.event_cluster_id === cluster
          ? Date.parse(record.event_first_published_at || "")
          : NaN
      ];
    }).filter(Number.isFinite);
    const firstPublished = timestamps.length > 0 ? Math.min(...timestamps) : null;
    for (const article of members) {
      const record = history?.articles?.[canonicalNewsURL(article.url)];
      if (record) {
        record.event_cluster_id = cluster;
        record.event_first_published_at = firstPublished === null
          ? null : new Date(firstPublished).toISOString();
      }
      if (firstPublished !== null && firstPublished < cutoff
          && Number.isInteger(article.score_notif)) {
        article.score_notif = Math.min(article.score_notif, 59);
      }
    }
  }
}

function writeFileAtomically(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

module.exports = {
  canonicalNewsURL,
  compactArticleID,
  isScore,
  normalizeEventNotifications,
  singletonClusterID,
  writeFileAtomically
};
