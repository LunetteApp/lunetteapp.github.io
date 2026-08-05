const test = require("node:test");
const assert = require("node:assert/strict");

const { contentHashForNews } = require("../news-hash");
const { validateNews } = require("../validate-news");

function fixture(clusterMains) {
  const items = clusterMains.map((cluster_main, index) => ({
    title: `Story ${index + 1}`,
    url: `https://example.com/story-${index + 1}`,
    source_name: "Example",
    lang: "en",
    score_quality: 70 - index,
    score_notif: 45,
    cluster: "shared-story",
    cluster_main
  }));
  const news = {
    last_updated: "2026-08-02T12:00:00.000Z",
    premium: { links: [] },
    sources: [],
    items
  };
  news.content_hash = contentHashForNews(news);
  const history = {
    articles: Object.fromEntries(items.map((item) => [item.url, {}]))
  };
  return { news, history };
}

test("validation requires exactly one explicit cluster main", () => {
  const valid = fixture([true, false]);
  assert.doesNotThrow(() => validateNews(valid.news, valid.history));

  const missing = fixture([undefined, false]);
  assert.throws(
    () => validateNews(missing.news, missing.history),
    /boolean cluster_main/
  );

  const duplicate = fixture([true, true]);
  assert.throws(
    () => validateNews(duplicate.news, duplicate.history),
    /exactly one cluster_main=true/
  );
});
