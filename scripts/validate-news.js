#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { contentHashForNews } = require("./news-hash");
const {
  historyRecord,
  readArticleHistory
} = require("./news-history");
const {
  canonicalNewsURL,
  isScore
} = require("./news-utils");

const ROOT = path.resolve(__dirname, "..");
const NEWS_PATH = path.join(ROOT, "api", "v1", "news.json");

function validateNews(news, history) {
  if (!news || typeof news !== "object" || Array.isArray(news)) {
    throw new Error("news.json must contain an object");
  }
  if (!Array.isArray(news.sources) || !Array.isArray(news.items)) {
    throw new Error("news.json must contain sources and items arrays");
  }
  if (news.content_hash !== contentHashForNews(news)) {
    throw new Error("news.json content_hash does not match its content");
  }
  if (!Number.isFinite(Date.parse(news.last_updated || ""))) {
    throw new Error("news.json last_updated must be an ISO date");
  }

  const sourceIdentities = new Set();
  for (const [index, source] of news.sources.entries()) {
    if (!source?.source_name || !source?.lang) {
      throw new Error(`Source ${index + 1} is missing source_name or lang`);
    }
    if (!Number.isFinite(source.estimated_articles_per_day)
        || source.estimated_articles_per_day < 0) {
      throw new Error(`Source ${source.source_name} has an invalid publication rate`);
    }
    if (source.new_articles_since_last_update !== null
        && (!Number.isInteger(source.new_articles_since_last_update)
          || source.new_articles_since_last_update < 0)) {
      throw new Error(`Source ${source.source_name} has an invalid new-article count`);
    }
    if (source.latest_article_at !== null
        && !Number.isFinite(Date.parse(source.latest_article_at || ""))) {
      throw new Error(`Source ${source.source_name} has an invalid latest_article_at`);
    }
    const identity = `${source.source_name}\u0000${source.lang}`;
    if (sourceIdentities.has(identity)) {
      throw new Error(`Duplicate source record for ${source.source_name} [${source.lang}]`);
    }
    sourceIdentities.add(identity);
    const allowedKeys = new Set([
      "source_name",
      "lang",
      "estimated_articles_per_day",
      "new_articles_since_last_update",
      "latest_article_at"
    ]);
    const unexpected = Object.keys(source).filter((key) => !allowedKeys.has(key));
    if (unexpected.length > 0) {
      throw new Error(`Source ${source.source_name} contains unexpected fields: ${unexpected.join(", ")}`);
    }
  }

  const URLs = new Set();
  const clusters = new Map();
  for (const [index, article] of news.items.entries()) {
    const label = `Article ${index + 1}`;
    if (!article?.title || !article?.url || !article?.source_name || !article?.lang) {
      throw new Error(`${label} is missing title, URL, source, or language`);
    }
    const canonicalURL = canonicalNewsURL(article.url);
    if (!canonicalURL || URLs.has(canonicalURL)) {
      throw new Error(`${label} has an empty or duplicate canonical URL`);
    }
    URLs.add(canonicalURL);
    if (!isScore(article.score_quality) || !isScore(article.score_notif)) {
      throw new Error(`${label} scores must be -1 or integers from 0 to 100`);
    }
    if (typeof article.cluster !== "string" || !article.cluster.trim()) {
      throw new Error(`${label} must have a cluster ID`);
    }
    if (typeof article.cluster_main !== "boolean") {
      throw new Error(`${label} must have a boolean cluster_main`);
    }
    const clusterArticles = clusters.get(article.cluster) ?? [];
    clusterArticles.push(article);
    clusters.set(article.cluster, clusterArticles);
    const record = historyRecord(history, article.url);
    if (!record) throw new Error(`${label} is missing from old_articles.json`);
    if (record.marketing === true) {
      throw new Error(`${label} is flagged as marketing and must not be in the feed`);
    }
    if ((article.score_quality === -1 || article.score_notif === -1)
        && record.scoring_pending !== true) {
      throw new Error(`${label} has unevaluated scores without scoring_pending`);
    }
  }

  for (const [cluster, articles] of clusters) {
    const mainCount = articles.filter((article) => article.cluster_main).length;
    if (mainCount !== 1) {
      throw new Error(`Cluster ${cluster} must have exactly one cluster_main=true article`);
    }
  }
}

function main() {
  const news = JSON.parse(fs.readFileSync(NEWS_PATH, "utf8"));
  const { history } = readArticleHistory();
  validateNews(news, history);
  console.log(
    `Validated ${news.items.length} news article(s), ${news.sources.length} source(s), and ${Object.keys(history.articles).length} historical URL(s).`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}

module.exports = {
  validateNews
};
