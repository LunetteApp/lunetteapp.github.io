const fs = require("fs");
const path = require("path");
const { canonicalNewsURL, normalizeClusterMains } = require("./news-utils");

const ROOT = path.resolve(__dirname, "..");
const NEWS_PATH = path.join(ROOT, "api", "v1", "news.json");
// Keep unreviewed publisher content outside the public API, including when
// inference is disabled or fails. The next analysis step reads this batch.
const CANDIDATES_PATH = path.join(ROOT, ".news-candidates.json");

function readAnalysisNews() {
  const filePath = fs.existsSync(CANDIDATES_PATH) ? CANDIDATES_PATH : NEWS_PATH;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function publishableNews(news, history) {
  const items = (news.items ?? []).filter((article) => {
    const record = history.articles[canonicalNewsURL(article.url)];
    return record?.topic_reviewed === true
      && record.off_topic !== true && record.marketing !== true;
  }).map((article) => ({ ...article }));
  normalizeClusterMains(items);
  return { ...news, items };
}

module.exports = { CANDIDATES_PATH, NEWS_PATH, publishableNews, readAnalysisNews };
