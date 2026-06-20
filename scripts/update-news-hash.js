#!/usr/bin/env node

const path = require("path");
const { updateNewsHashFile } = require("./news-hash");

const root = path.resolve(__dirname, "..");
const newsPath = path.join(root, "api", "v1", "news.json");
const result = updateNewsHashFile(newsPath);

if (result.changed) {
  console.log(`Updated api/v1/news.json content_hash: ${result.hash}`);
} else {
  console.log(`api/v1/news.json content_hash is up to date: ${result.hash}`);
}
