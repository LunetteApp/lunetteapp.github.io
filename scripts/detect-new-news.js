#!/usr/bin/env node

const { readAnalysisNews } = require("./news-publication");
const {
  historyRecord,
  readArticleHistory
} = require("./news-history");

const news = readAnalysisNews();
const { history } = readArticleHistory();
const articles = Array.isArray(news.items) ? news.items : [];
const forceRescoring = process.env.NEWS_FORCE_RESCORING === "true";
const scoringPending = articles.filter((article) => {
  const record = historyRecord(history, article.url);
  return forceRescoring
    || article.score_quality === -1
    || article.score_notif === -1
    || record?.scoring_pending === true;
});
const clusteringPending = articles.filter((article) =>
  historyRecord(history, article.url)?.clustering_pending === true
    || historyRecord(history, article.url)?.topic_reviewed !== true
);

console.log(`scoring_pending=${scoringPending.length}`);
console.log(`clustering_pending=${clusteringPending.length}`);
console.log(`needs_inference=${scoringPending.length > 0 || clusteringPending.length > 0}`);
