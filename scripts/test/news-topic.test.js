const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseFeed, matchesSourceFilters } = require("../build-news");
const { analyseArticles, analysisPrompt } = require("../analyze-news");
const { compactArticleID } = require("../news-utils");
const { emptyHistory, upsertHistoryRecord } = require("../news-history");
const config = require("../../feed_websites.json");
const { publishableNews } = require("../news-publication");
const { serializedNews } = require("../news-hash");
const { validateNews } = require("../validate-news");

const deployant = config.sources.find((source) => source.source_name === "Deployant");
const monochrome = config.sources.find((source) => source.source_name === "Monochrome Watches");
const title = "Suzuki e-Vitara Review: Electric SUV Lifestyle Test with Video";
const url = "https://deployant.com/suzuki-e-vitara-review/";

test("RSS categories survive ingestion and exclude the Suzuki review before inference", async () => {
  const [article] = await parseFeed(`<rss version="2.0"><channel><title>Deployant</title>
    <item><title>${title}</title><link>${url}</link>
    <category>Automotive</category><category>Horological Lifestyle</category>
    <category>suzuki</category><category>Automotive</category></item>
    </channel></rss>`, deployant);

  assert.deepEqual(article.categories, ["Automotive", "Horological Lifestyle", "suzuki"]);
  assert.equal(matchesSourceFilters(article, deployant), false);
  assert.match(analysisPrompt([article], new Date()), /categories: Automotive, Horological Lifestyle, suzuki/);
  const history = emptyHistory();
  assert.deepEqual(upsertHistoryRecord(history, article, new Date()).categories, article.categories);
});

test("Atom categories and JSON Feed tags reach the same source filter", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Deployant</title>
    <entry><title>${title}</title><id>${url}</id><link href="${url}"/>
    <category term="Automotive"/></entry></feed>`;
  const json = JSON.stringify({ items: [{ title, url, tags: ["Automotive"] }] });
  for (const feed of [atom, json]) {
    const [article] = await parseFeed(feed, deployant);
    assert.deepEqual(article.categories, ["Automotive"]);
    assert.equal(matchesSourceFilters(article, deployant), false);
  }
});

test("the Petrolhead column is excluded even from cached articles without categories", () => {
  assert.equal(matchesSourceFilters({
    title: "The Petrolhead Corner – The New Porsche Mission S, An Ode To The Sports Car"
  }, monochrome), false);
  assert.equal(matchesSourceFilters({ title: "Mission S", categories: ["The Petrolhead Corner", "Cars"] }, monochrome), false);
});

test("automotive watch stories remain eligible for the watch feed", async () => {
  for (const [source, watchTitle, tags] of [
    [deployant, "Porsche Design Chronograph 1 review", ["Review", "Porsche Design"]],
    [monochrome, "TAG Heuer Formula 1 x Red Bull Racing", ["Introducing", "TAG Heuer"]],
    [config.sources.find((source) => source.source_name === "Time+Tide"),
      "Yema, Depancel and Reservoir: three French automotive watch brands", ["Watches"]]
  ]) {
    const [article] = await parseFeed(JSON.stringify({ items: [{ title: watchTitle, url, tags }] }), source);
    assert.equal(matchesSourceFilters(article, source), true);
  }
});

test("analysis removes a zero-score car story from clusters while retaining a racing watch", async () => {
  const articles = [
    { title, url, categories: ["Automotive"], score_quality: 0, score_notif: 0 },
    { title: "TAG Heuer Formula 1 x Red Bull Racing", url: "https://example.com/watch", score_quality: 75, score_notif: 70 }
  ];
  const result = await analyseArticles(articles, "test-model", async (request) => {
    assert.ok(request.outputSchema.required.includes("off_topic"));
    return { message: { content: JSON.stringify({
      scores: [], marketing: [], off_topic: [0],
      clusters: [{ story: "Incorrect automotive cluster", lines: [0, 1] }]
    }) } };
  });
  assert.deepEqual(result.off_topic, [compactArticleID(url)]);
  assert.deepEqual(result.clusters, []);
  assert.equal(result.scores[compactArticleID(articles[1].url)].notification, 70);
});

test("analysis rejects a missing topic decision rather than silently accepting a car story", async () => {
  await assert.rejects(analyseArticles([{ title, url }], "test-model", async () => ({
    message: { content: JSON.stringify({ scores: [[0, 0]], marketing: [], clusters: [] }) }
  })), /off_topic must be an array/);
});

test("publication withholds unreviewed candidates when inference is skipped or fails", () => {
  const articles = [
    { title, url, score_notif: 0, score_quality: 0, cluster: "car", cluster_main: true },
    { title: "New racing watch", url: "https://example.com/watch", score_notif: -1, score_quality: -1, cluster: "watch", cluster_main: true },
    { title: "Reviewed watch", url: "https://example.com/reviewed", score_notif: 45, score_quality: 75, cluster: "reviewed", cluster_main: true }
  ];
  const news = { items: articles };
  const history = { articles: {
    [url]: { scoring_pending: true },
    [articles[1].url]: { scoring_pending: true },
    [articles[2].url]: { topic_reviewed: true }
  } };
  assert.deepEqual(publishableNews(news, history).items, [articles[2]]);
  assert.equal(news.items.length, 3);
  history.articles[articles[1].url].topic_reviewed = true;
  history.articles[url].topic_reviewed = true;
  history.articles[url].off_topic = true;
  assert.deepEqual(publishableNews(news, history).items, articles.slice(1));
});

test("publication promotes a reviewed watch when its unreviewed cluster lead is withheld", () => {
  const articles = [
    { title, url, cluster: "story", cluster_main: true, score_quality: 0 },
    { title: "A watch", url: "https://example.com/watch", cluster: "story", cluster_main: false, score_quality: 75 }
  ];
  const history = { articles: { [articles[1].url]: { topic_reviewed: true } } };
  const published = publishableNews({ items: articles }, history);
  assert.equal(published.items.length, 1);
  assert.equal(published.items[0].cluster_main, true);
  assert.equal(articles[1].cluster_main, false);
});

function analysisFixture(t, fail) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunette-news-topic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.resolve(__dirname, ".."), path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "api/v1"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const now = new Date().toISOString();
  const articles = [
    { title: "Reviewed watch", url: "https://example.com/reviewed", score_quality: 75, score_notif: 45 },
    { title, url, categories: ["Automotive"], score_quality: 0, score_notif: 0 },
    { title: "New racing watch", url: "https://example.com/new", score_quality: -1, score_notif: -1 }
  ].map((article, index) => ({ ...article, lang: "en", source_name: "Example", published_at: now, cluster: `story-${index}`, cluster_main: true }));
  const history = emptyHistory();
  for (const article of articles) upsertHistoryRecord(history, article, now);
  history.articles[articles[0].url].topic_reviewed = true;
  const news = { last_updated: now, sources: [], items: articles };
  fs.writeFileSync(path.join(root, ".news-candidates.json"), serializedNews(news));
  fs.writeFileSync(path.join(root, "api/v1/news.json"), serializedNews(publishableNews(news, history)));
  fs.writeFileSync(path.join(root, "data/old_articles.json"), JSON.stringify(history));
  const response = { scores: [[75, 65]], marketing: [], off_topic: [1], clusters: [] };
  fs.writeFileSync(path.join(root, "provider-stub.js"), `
    require('./scripts/llm-provider').createLLMProvider = () => ({
      model: 'test-model',
      request: async () => { ${fail ? "throw new Error('provider unavailable');" : `return { message: { content: ${JSON.stringify(JSON.stringify(response))} } };`} },
      totalSpend: () => ({ formatted: '$0', calls: 0, input: 0, output: 0 })
    });
  `);
  const result = spawnSync(process.execPath, ["--require", "./provider-stub.js", "scripts/analyze-news.js"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return {
    root, articles,
    news: JSON.parse(fs.readFileSync(path.join(root, "api/v1/news.json"), "utf8")),
    history: JSON.parse(fs.readFileSync(path.join(root, "data/old_articles.json"), "utf8"))
  };
}

test("a failed analysis keeps new candidates private and pending for retry", (t) => {
  const fixture = analysisFixture(t, true);
  assert.deepEqual(fixture.news.items.map((article) => article.title), ["Reviewed watch"]);
  assert.doesNotThrow(() => validateNews(fixture.news, fixture.history));
  const pending = spawnSync(process.execPath, ["scripts/detect-new-news.js"], { cwd: fixture.root, encoding: "utf8" });
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /needs_inference=true/);
  assert.equal(fixture.history.articles[url].scoring_pending, true);
});

test("a successful analysis publishes watches and persists the car's exclusion", (t) => {
  const fixture = analysisFixture(t, false);
  assert.deepEqual(fixture.news.items.map((article) => article.title), ["Reviewed watch", "New racing watch"]);
  assert.equal(fixture.history.articles[url].off_topic, true);
  assert.equal(fixture.history.articles[url].topic_reviewed, true);
  assert.doesNotThrow(() => validateNews(fixture.news, fixture.history));
  const pending = spawnSync(process.execPath, ["scripts/detect-new-news.js"], { cwd: fixture.root, encoding: "utf8" });
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /needs_inference=false/);
});
