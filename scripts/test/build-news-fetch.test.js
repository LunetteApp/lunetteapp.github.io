const assert = require("node:assert/strict");
const test = require("node:test");

const { fetchText, normalizeClusterMains, preserveEvaluationMetadata } = require("../build-news");
const { normalizeEventNotifications } = require("../news-utils");
const { contentHashForNews } = require("../news-hash");
const { validateNews } = require("../validate-news");

const URL = "https://publisher.example/feed";

test("a feed build replaces a removed cluster main before inference", () => {
  const previous = [
    { url: "https://publisher.example/main", score_quality: 81, cluster_main: true },
    { url: "https://publisher.example/runner-up", score_quality: 76, cluster_main: false },
    { url: "https://publisher.example/other", score_quality: 72, cluster_main: false }
  ].map((article) => ({
    ...article,
    title: "Auction report",
    source_name: "Publisher",
    lang: "en",
    score_notif: 34,
    cluster: "20260928-70f86d451bef"
  }));
  const items = previous.slice(1).map((article) =>
    preserveEvaluationMetadata({
      title: article.title,
      url: article.url,
      source_name: article.source_name,
      lang: article.lang
    }, article)
  );
  const news = {
    last_updated: "2026-10-03T12:00:00.000Z",
    sources: [],
    items
  };
  const history = { articles: Object.fromEntries(items.map((article) => [article.url, {}])) };
  news.content_hash = contentHashForNews(news);
  assert.throws(() => validateNews(news, history), /exactly one cluster_main=true/);

  normalizeClusterMains(items);
  news.content_hash = contentHashForNews(news);

  assert.doesNotThrow(() => validateNews(news, history));
  assert.deepEqual(items.map((article) => article.cluster_main), [true, false]);
  for (const article of items) {
    const original = previous.find((item) => item.url === article.url);
    assert.equal(article.cluster, original.cluster);
    assert.equal(article.score_quality, original.score_quality);
    assert.equal(article.score_notif, original.score_notif);
  }
});

test("a surviving cluster main keeps precedence over higher quality members", () => {
  const items = [
    { url: "https://publisher.example/main", cluster: "event", cluster_main: true, score_quality: 70 },
    { url: "https://publisher.example/other", cluster: "event", cluster_main: false, score_quality: 90 }
  ];
  const original = structuredClone(items);

  normalizeClusterMains(items);

  assert.deepEqual(items, original);
});

test("a lone remaining cluster member becomes its main", () => {
  const item = { url: "https://publisher.example/only", cluster: "event", cluster_main: false, score_quality: 72 };
  normalizeClusterMains([item]);
  assert.equal(item.cluster_main, true);
  assert.equal(item.cluster, "event");
});

test("duplicate cluster mains resolve to one existing main", () => {
  const items = [
    { url: "https://publisher.example/a", cluster: "event", cluster_main: true, score_quality: 70 },
    { url: "https://publisher.example/b", cluster: "event", cluster_main: true, score_quality: 80 },
    { url: "https://publisher.example/c", cluster: "event", cluster_main: false, score_quality: 90 }
  ];
  normalizeClusterMains(items);
  assert.deepEqual(items.map((article) => article.cluster_main), [false, true, false]);
});

test("unscored clusters choose a stable main regardless of feed order", () => {
  const items = ["b", "a"].map((slug) => ({
    url: `https://publisher.example/${slug}`,
    cluster: "event",
    cluster_main: false,
    score_quality: -1
  }));
  for (const ordered of [items, [...items].reverse()]) {
    const articles = ordered.map((article) => ({ ...article }));
    normalizeClusterMains(articles);
    assert.equal(articles.find((article) => article.cluster_main).url, "https://publisher.example/a");
  }
});

test("a new feed build retains an event's first publication date and caps old alerts", () => {
  const item = {
    url: "https://publisher.example/late-report",
    published_at: "2026-09-26T13:30:00.000Z"
  };
  preserveEvaluationMetadata(item, {
    score_quality: 65,
    score_notif: 63,
    cluster: "old-event",
    cluster_main: true
  });
  const history = { articles: {
    [item.url]: {
      event_cluster_id: "old-event",
      event_first_published_at: "2026-09-22T13:00:00.000Z"
    }
  } };
  normalizeEventNotifications([item], new Date("2026-09-26T15:00:00.000Z"), history);

  assert.equal(history.articles[item.url].event_first_published_at, "2026-09-22T13:00:00.000Z");
  assert.equal(Object.hasOwn(item, "event_first_published_at"), false);
  assert.equal(item.score_notif, 34);
});

test("an existing cluster is aged from its oldest article without changing feed fields", () => {
  const earlier = {
    url: "https://publisher.example/first-report",
    cluster: "release-event",
    published_at: "2026-09-22T13:00:00.000Z",
    score_notif: 54
  };
  const later = {
    url: "https://publisher.example/late-report",
    cluster: "release-event",
    published_at: "2026-09-26T13:30:00.000Z",
    score_notif: 63
  };
  const history = { articles: { [earlier.url]: {}, [later.url]: {} } };
  const originalKeys = [earlier, later].map((item) => Object.keys(item));

  normalizeEventNotifications([earlier, later], new Date("2026-09-26T15:00:00.000Z"), history);

  assert.equal(later.score_notif, 34);
  assert.equal(history.articles[later.url].event_first_published_at, earlier.published_at);
  assert.deepEqual([earlier, later].map((item) => Object.keys(item)), originalKeys);
});

test("a valid Chrome response makes exactly one publisher navigation", async () => {
  const engines = [];
  const result = await fetchText(URL, 1000, {
    validate: (text) => text === "valid feed",
    browserFetch: async (_url, { engine }) => {
      engines.push(engine);
      return { engine, text: "valid feed" };
    }
  });

  assert.equal(result, "valid feed");
  assert.deepEqual(engines, ["chrome"]);
});

test("an invalid Chrome response gets one Firefox attempt", async () => {
  const engines = [];
  const result = await fetchText(URL, 1000, {
    validate: (text) => text === "valid feed",
    browserFetch: async (_url, { engine }) => {
      engines.push(engine);
      return {
        engine,
        text: engine === "chrome" ? "challenge page" : "valid feed"
      };
    }
  });

  assert.equal(result, "valid feed");
  assert.deepEqual(engines, ["chrome", "firefox"]);
});

test("two failed browsers stop without a third publisher navigation", async () => {
  const engines = [];

  await assert.rejects(
    fetchText(URL, 1000, {
      validate: () => false,
      browserFetch: async (_url, { engine }) => {
        engines.push(engine);
        throw new Error(`${engine} rejected`);
      }
    }),
    /Chrome and Firefox did not return a valid feed/
  );

  assert.deepEqual(engines, ["chrome", "firefox"]);
});
