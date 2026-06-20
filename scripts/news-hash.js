const crypto = require("crypto");
const fs = require("fs");

function newsHashInput(news) {
  return {
    premium: news.premium ?? { links: [] },
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
    items,
    ...rest
  } = news;

  return {
    content_hash: contentHash,
    last_updated: lastUpdated,
    premium: premium ?? { links: [] },
    items: Array.isArray(items) ? items : [],
    ...rest
  };
}

function serializedNews(news) {
  return `${JSON.stringify(orderedNewsForOutput(news), null, 2)}\n`;
}

function updateNewsHashFile(filePath) {
  const news = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const nextHash = contentHashForNews(news);
  const nextContent = serializedNews(news);
  const currentContent = fs.readFileSync(filePath, "utf8");
  if (news.content_hash === nextHash && currentContent === nextContent) {
    return { changed: false, hash: nextHash };
  }

  fs.writeFileSync(filePath, nextContent);
  return { changed: true, hash: nextHash };
}

module.exports = {
  contentHashForNews,
  orderedNewsForOutput,
  serializedNews,
  updateNewsHashFile
};
