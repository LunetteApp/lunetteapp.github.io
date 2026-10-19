const test = require("node:test");
const assert = require("node:assert/strict");
const { analyseArticles } = require("../analyze-news");
const { matchesSourceFilters, parseFeed } = require("../build-news");
const { contentHashForNews } = require("../news-hash");
const { publishableNews } = require("../news-publication");
const { compactArticleID, marketingReason } = require("../news-utils");
const { validateNews } = require("../validate-news");

const campaign = {
  title: "Introducing – The Semi-Openworked Version Watches V0201-TH, now on Kickstarter",
  url: "https://monochrome-watches.com/the-semi-openworked-version-watches-v0201-th-now-on-kickstarter/",
  categories: ["Version Watches", "2026", "Novelty", "Value Proposition"],
  source_name: "Monochrome Watches", lang: "en", score_quality: 68, score_notif: 62,
  cluster: "campaign", cluster_main: true
};

test("the Monochrome campaign is filtered even without an advertising category", async () => {
  const source = { source_name: campaign.source_name, lang: "en", feed_url: "https://monochrome-watches.com/feed/" };
  const [article] = await parseFeed(JSON.stringify({ items: [
    { title: campaign.title, url: campaign.url, tags: campaign.categories }
  ] }), source);
  assert.equal(marketingReason(article), "crowdfunding campaign promotion");
  assert.equal(matchesSourceFilters(article, source), false);
});

test("an old editorial approval cannot publish an explicit campaign promotion", () => {
  const history = { articles: { [campaign.url]: { topic_reviewed: true } } };
  const news = { last_updated: new Date().toISOString(), sources: [], items: [campaign] };
  assert.deepEqual(publishableNews(news, history).items, []);
  news.content_hash = contentHashForNews(news);
  assert.throws(() => validateNews(news, history), /explicit marketing/);
});

test("an empty model marketing decision cannot override an explicit promotion", async () => {
  const articles = [campaign, {
    ...campaign, title: "Hands-on with an independent watch", url: "https://example.com/watch"
  }];
  const result = await analyseArticles(articles, "test-model", async () => ({
    message: { content: JSON.stringify({ scores: [], marketing: [], off_topic: [],
      clusters: [{ story: "Mistaken grouping", lines: [0, 1] }] }) }
  }));
  assert.deepEqual(result.marketing, [compactArticleID(campaign.url)]);
  assert.deepEqual(result.clusters, []);
});

test("explicit ad labels and campaign calls are blocked", () => {
  for (const title of ["Introducing a watch, NOW LIVE ON Kickstarter", "A new diver, now on Indiegogo", "[Sponsored] A new watch", "ADV: A new watch"]) {
    assert.ok(marketingReason({ title }), title);
  }
  for (const category of ["Sponsored", "Advertorial", "Paid Partnership", "ADV"]) {
    assert.ok(marketingReason({ title: "Introducing a new watch", categories: [category] }), category);
  }
});

test("independent crowdfunding reporting and normal watch launches remain eligible", () => {
  for (const title of [
    "Why a Kickstarter watch campaign failed to deliver",
    "Investigating the collapse of a crowdfunding watch brand",
    "Hands-on with a watch originally funded through Kickstarter",
    "Introducing the Acme Diver Ref. 123",
    "A new watch partnership between two independent brands"
  ]) {
    assert.equal(marketingReason({ title }), null, title);
    assert.equal(matchesSourceFilters({ title }, {}), true, title);
  }
});
