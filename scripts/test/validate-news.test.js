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
    articles: Object.fromEntries(items.map((item) => [item.url, { topic_reviewed: true }]))
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

  const noMain = fixture([false, false]);
  assert.throws(
    () => validateNews(noMain.news, noMain.history),
    /exactly one cluster_main=true/
  );
});

test("validation rejects changes to the news article JSON structure", () => {
  const { news, history } = fixture([true]);
  news.items[0].event_first_published_at = "2026-08-02T12:00:00.000Z";
  news.content_hash = contentHashForNews(news);

  assert.throws(() => validateNews(news, history), /unexpected fields/);
});

test("validation rejects an off-topic article even when its notification score is zero", () => {
  const { news, history } = fixture([true]);
  news.items[0].score_notif = 0;
  history.articles[news.items[0].url].off_topic = true;
  news.content_hash = contentHashForNews(news);
  assert.throws(() => validateNews(news, history), /off-topic/);
});

test("publisher categories are optional for legacy articles and validated when supplied", () => {
  const { news, history } = fixture([true]);
  news.items[0].categories = ["Watches", "Review"];
  news.content_hash = contentHashForNews(news);
  assert.doesNotThrow(() => validateNews(news, history));
  news.items[0].categories = [42];
  news.content_hash = contentHashForNews(news);
  assert.throws(() => validateNews(news, history), /categories/);
});

test("unreviewed articles cannot be published even if they have valid scores", () => {
  const { news, history } = fixture([true]);
  delete history.articles[news.items[0].url].topic_reviewed;
  assert.throws(() => validateNews(news, history), /has not passed watch-topic review/);
});
