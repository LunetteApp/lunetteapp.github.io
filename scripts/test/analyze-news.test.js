const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INSTRUCTIONS,
  analyseArticles,
  analysisPrompt,
  applyClusterGroups,
  resolveClusters,
  resolveMarketing,
  withoutArticles
} = require("../analyze-news");
const { resolveLLMConfig } = require("../llm-provider");
const { compactArticleID, singletonClusterID } = require("../news-utils");

function article({
  title,
  url,
  source = "Example Watches",
  lang = "en",
  published = "2026-08-02T10:00:00.000Z",
  cluster
}) {
  return {
    title,
    url,
    source_name: source,
    lang,
    published_at: published,
    cluster
  };
}

test("the batch contains titles, sources, languages, and no article URLs", () => {
  const articles = [article({
    title: "  A precise\nwatch headline  ",
    url: "https://example.com/never-send-this-url",
    source: "Trusted Watch Source",
    lang: "IT"
  })];

  const prompt = analysisPrompt(articles, new Date("2026-08-02T12:34:00.000Z"));

  assert.match(prompt, /source: Trusted Watch Source/);
  assert.match(prompt, /language: it/);
  assert.match(prompt, /A precise watch headline/);
  assert.doesNotMatch(prompt, /never-send-this-url/);
});

test("the prompt treats 60 as a scarce hourly notification slot", () => {
  assert.match(INSTRUCTIONS, /at most one news notification per hour/);
  assert.match(INSTRUCTIONS, /score of 60 or\s+more/);
  assert.match(INSTRUCTIONS, /same\s+notification score/);
  assert.match(INSTRUCTIONS, /first element of lines/);
  assert.match(INSTRUCTIONS, /shortened brand name/);
  assert.match(INSTRUCTIONS, /Moser's Repeater is Cosmic/);
});

test("production title analysis defaults to gpt-5.4 with medium reasoning", () => {
  const config = resolveLLMConfig({ LLM_API_KEY: "test-key" });
  assert.equal(config.model, "gpt-5.4");
  assert.equal(config.reasoningEffort, "medium");
});

test("empty workflow price variables do not override gpt-5.4 pricing with zero", () => {
  const config = resolveLLMConfig({
    LLM_API_KEY: "test-key",
    LLM_PRICE_INPUT: "",
    LLM_PRICE_OUTPUT: "  ",
    LLM_PRICE_CACHED_INPUT: ""
  });

  assert.deepEqual(config.prices, {
    input: 2.5,
    output: 15,
    cachedInput: 0.25
  });
});

test("one title-only call scores, clusters, and chooses the main title", async () => {
  const articles = [
    article({
      title: "Coming Soon: Acme Diver",
      url: "https://general.example/acme-teaser",
      source: "General News"
    }),
    article({
      title: "Introducing the Acme Diver Ref. 123 with full specifications",
      url: "https://specialist.example/acme-diver-123",
      source: "Specialist Watches"
    }),
    article({
      title: "A history of marine chronometers",
      url: "https://history.example/marine-chronometers",
      source: "Horology Review"
    })
  ];
  const requests = [];
  const request = async (payload) => {
    requests.push(payload);
    return {
      message: {
        content: JSON.stringify({
          scores: [[90, 70], [80, 65], [75, 20]],
          marketing: [],
          clusters: [{ story: "Acme Diver Ref. 123", lines: [1, 0] }]
        })
      }
    };
  };

  const result = await analyseArticles(articles, "test-model", request);
  const teaserID = compactArticleID(articles[0].url);
  const mainID = compactArticleID(articles[1].url);

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].outputSchema.properties.clusters.items.properties.main_line,
    undefined
  );
  assert.equal(
    requests[0].outputSchema.properties.clusters.items.properties.cluster_main,
    undefined
  );
  assert.match(requests[0].messages[1].content, /source: Specialist Watches/);
  assert.doesNotMatch(requests[0].messages[1].content, /specialist\.example/);
  assert.equal(result.clusters[0].mainArticleID, mainID);
  assert.deepEqual(result.clusters[0].articleIDs, [mainID, teaserID]);
  assert.equal(result.scores[teaserID].notification, 65);
  assert.equal(result.scores[mainID].notification, 65);
  assert.ok(result.scores[mainID].quality > result.scores[teaserID].quality);
});

test("a clustering-only run retains scores and accepts an empty score response", async () => {
  const articles = [
    {
      ...article({ title: "Moser Cosmic Rain", url: "https://one.example/moser" }),
      score_quality: 70,
      score_notif: 44
    },
    {
      ...article({ title: "Moser's Repeater is Cosmic", url: "https://two.example/moser" }),
      score_quality: 80,
      score_notif: 46
    }
  ];
  const requests = [];
  const result = await analyseArticles(articles, "test-model", async (payload) => {
    requests.push(payload);
    return {
      message: {
        content: JSON.stringify({
          scores: [],
          marketing: [],
          clusters: [{ story: "Moser Cosmic Rain", lines: [1, 0] }]
        })
      }
    };
  });
  const firstID = compactArticleID(articles[0].url);
  const mainID = compactArticleID(articles[1].url);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].outputSchema.properties.scores.maxItems, 0);
  assert.match(requests[0].messages[1].content, /Score lines: none/);
  assert.equal(result.scores[firstID].notification, 46);
  assert.equal(result.scores[mainID].notification, 46);
  assert.equal(result.scores[mainID].quality, 80);
});

test("an incremental run requests and maps scores only for unscored lines", async () => {
  const articles = [
    {
      ...article({ title: "Already scored", url: "https://one.example/scored" }),
      score_quality: 72,
      score_notif: 35
    },
    {
      ...article({ title: "New article", url: "https://two.example/new" }),
      score_quality: -1,
      score_notif: -1
    }
  ];
  const requests = [];
  const result = await analyseArticles(articles, "test-model", async (payload) => {
    requests.push(payload);
    return {
      message: {
        content: JSON.stringify({ scores: [[81, 62]], marketing: [], clusters: [] })
      }
    };
  });

  assert.equal(requests[0].outputSchema.properties.scores.maxItems, 1);
  assert.match(requests[0].messages[1].content, /Score lines: 1/);
  assert.deepEqual(result.scores[compactArticleID(articles[0].url)], {
    quality: 72,
    notification: 35
  });
  assert.deepEqual(result.scores[compactArticleID(articles[1].url)], {
    quality: 81,
    notification: 62
  });
});

test("the same call names the marketing lines it wants removed", async () => {
  const articles = [
    article({
      title: "Introducing the Acme Diver Ref. 123",
      url: "https://specialist.example/acme-diver-123"
    }),
    article({
      title: "Win an Acme Diver - Enter Our Reader Giveaway",
      url: "https://general.example/acme-giveaway"
    })
  ];

  const result = await analyseArticles(articles, "test-model", async () => ({
    message: {
      content: JSON.stringify({
        scores: [[75, 55], [10, 5]],
        marketing: [1],
        clusters: []
      })
    }
  }));

  assert.deepEqual(result.marketing, [compactArticleID(articles[1].url)]);
});

test("a cluster loses a marketing member and keeps the next line as its main", () => {
  const groups = withoutArticles([
    { story: "Advert first", mainArticleID: "a", articleIDs: ["a", "b", "c"] },
    { story: "Pair", mainArticleID: "d", articleIDs: ["d", "e"] }
  ], new Set(["a", "e"]));

  assert.deepEqual(groups, [
    { story: "Advert first", mainArticleID: "b", articleIDs: ["b", "c"] }
  ]);
});

test("marketing lines outside the list are rejected", () => {
  assert.throws(() => resolveMarketing([2], ["a", "b"]), /valid line number/);
  assert.deepEqual(resolveMarketing([1, 1], ["a", "b"]), ["b"]);
});

test("the prompt tells the model to judge purpose rather than tone", () => {
  assert.match(INSTRUCTIONS, /MARKETING/);
  assert.match(INSTRUCTIONS, /Judge purpose, not tone/);
  assert.match(INSTRUCTIONS, /removed from the feed entirely/);
});

test("the first cluster element is the main title", () => {
  const [group] = resolveClusters(
    [{ story: "Acme Diver", lines: [2, 0, 1] }],
    ["a", "b", "c"]
  );

  assert.equal(group.mainArticleID, "c");
  assert.deepEqual(group.articleIDs, ["c", "a", "b"]);
});

test("a line claimed by two clusters stays in the first", () => {
  const groups = resolveClusters([
    { story: "First", lines: [0, 1] },
    { story: "Second", lines: [2, 1, 3] }
  ], ["a", "b", "c", "d"]);

  assert.deepEqual(groups, [
    { story: "First", mainArticleID: "a", articleIDs: ["a", "b"] },
    { story: "Second", mainArticleID: "c", articleIDs: ["c", "d"] }
  ]);
});

test("an established cluster id survives when a new duplicate is added", () => {
  const articles = [
    article({
      title: "Acme Diver announcement",
      url: "https://one.example/acme",
      published: "2026-08-01T10:00:00.000Z",
      cluster: "stable-story-id"
    }),
    article({
      title: "Acme Diver hands-on",
      url: "https://two.example/acme",
      published: "2026-08-01T11:00:00.000Z",
      cluster: "stable-story-id"
    }),
    article({
      title: "Acme Diver specifications",
      url: "https://three.example/acme",
      published: "2026-08-02T09:00:00.000Z"
    })
  ];
  articles[2].cluster = singletonClusterID(articles[2]);
  const ids = articles.map((item) => compactArticleID(item.url));

  applyClusterGroups(articles, [{
    story: "Acme Diver",
    mainArticleID: ids[1],
    articleIDs: [ids[1], ids[0], ids[2]]
  }]);

  assert.deepEqual(articles.map((item) => item.cluster), [
    "stable-story-id",
    "stable-story-id",
    "stable-story-id"
  ]);
  assert.deepEqual(articles.map((item) => item.cluster_main), [false, true, false]);
});

test("JavaScript marks singleton stories as their own cluster main", () => {
  const articles = [article({
    title: "A standalone watch story",
    url: "https://one.example/standalone"
  })];

  applyClusterGroups(articles, []);

  assert.equal(articles[0].cluster_main, true);
});
