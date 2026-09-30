const assert = require("node:assert/strict");
const test = require("node:test");

const { fetchText, preserveEvaluationMetadata } = require("../build-news");
const { normalizeEventNotifications } = require("../news-utils");

const URL = "https://publisher.example/feed";

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
