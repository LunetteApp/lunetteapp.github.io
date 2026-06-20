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

function updateNewsHashFile(filePath) {
  const news = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const nextHash = contentHashForNews(news);
  if (news.content_hash === nextHash) {
    return { changed: false, hash: nextHash };
  }

  news.content_hash = nextHash;
  fs.writeFileSync(filePath, `${JSON.stringify(news, null, 2)}\n`);
  return { changed: true, hash: nextHash };
}

module.exports = {
  contentHashForNews,
  updateNewsHashFile
};
