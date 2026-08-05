#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  historyRecord,
  readArticleHistory
} = require("./news-history");

const ROOT = path.resolve(__dirname, "..");
const NEWS_PATH = path.join(ROOT, "api", "v1", "news.json");

const news = JSON.parse(fs.readFileSync(NEWS_PATH, "utf8"));
const { history } = readArticleHistory();
const articles = Array.isArray(news.items) ? news.items : [];
const scoringPending = articles.filter((article) => {
  const record = historyRecord(history, article.url);
  return article.score_quality === -1
    || article.score_notif === -1
    || record?.scoring_pending === true;
});
const clusteringPending = articles.filter((article) =>
  historyRecord(history, article.url)?.clustering_pending === true
);

console.log(`scoring_pending=${scoringPending.length}`);
console.log(`clustering_pending=${clusteringPending.length}`);
console.log(`needs_inference=${scoringPending.length > 0 || clusteringPending.length > 0}`);
