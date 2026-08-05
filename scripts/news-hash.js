const crypto = require("crypto");

function newsHashInput(news) {
  return {
    premium: news.premium ?? { links: [] },
    sources: (Array.isArray(news.sources) ? news.sources : []).map((source) => ({
      source_name: source?.source_name ?? "",
      lang: source?.lang ?? "und"
    })),
    items: Array.isArray(news.items) ? news.items : []
  };
}

function contentHashForNews(news) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(newsHashInput(news)))
    .digest("hex");
}

function orderedNewsForOutput(news) {
  const contentHash = contentHashForNews(news);
  const {
    content_hash: _contentHash,
    last_updated: lastUpdated,
    premium,
    sources,
    items,
    ...rest
  } = news;

  return {
    content_hash: contentHash,
    last_updated: lastUpdated,
    premium: premium ?? { links: [] },
    sources: Array.isArray(sources) ? sources : [],
    items: Array.isArray(items) ? items : [],
    ...rest
  };
}

function serializedNews(news) {
  return `${JSON.stringify(orderedNewsForOutput(news), null, 2)}\n`;
}

module.exports = {
  contentHashForNews,
  orderedNewsForOutput,
  serializedNews
};
