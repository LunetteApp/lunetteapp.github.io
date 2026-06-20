#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TEST_URLS_PATH = path.join(ROOT, "feed_test_urls.json");
const USER_AGENT = "LunetteNewsBot/1.0 (+https://lunetteapp.com)";

async function main() {
  const config = JSON.parse(await fs.readFile(TEST_URLS_PATH, "utf8"));
  const minimumItems = Number.isFinite(Number(config.minimum_items)) ? Number(config.minimum_items) : 1;
  const urls = Array.isArray(config.urls) ? config.urls : [];
  const results = [];

  for (const entry of urls) {
    results.push(await checkEntry(entry, minimumItems));
  }

  const selectedResults = results.filter((result) => !result.candidate);
  const selectedFailures = selectedResults.filter((result) => !result.ok);
  const languages = [...new Set(selectedResults.filter((result) => result.ok).map((result) => result.lang))].sort();

  console.table(results.map((result) => ({
    lang: result.lang,
    source: result.source_name,
    candidate: result.candidate ? "yes" : "",
    status: result.status ?? "",
    feed_items: result.feed_items,
    matching_items: result.matching_items,
    ok: result.ok ? "yes" : "no",
    note: result.note ?? result.error ?? ""
  })));

  console.log(`Covered selected languages: ${languages.join(", ") || "none"}`);

  if (selectedFailures.length > 0) {
    console.error(`Failed selected feed(s): ${selectedFailures.map((result) => result.source_name).join(", ")}`);
    process.exitCode = 1;
  }
}

async function checkEntry(entry, minimumItems) {
  try {
    const response = await fetch(entry.feed_url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml;q=0.9, */*;q=0.5" }
    });
    const text = await response.text();
    const feedItems = countFeedItems(text);
    const matchingItems = countMatchingItems(text, entry);
    const ok = response.ok && matchingItems >= minimumItems;

    return {
      source_name: entry.source_name,
      lang: entry.lang,
      candidate: entry.candidate === true,
      status: response.status,
      feed_items: feedItems,
      matching_items: matchingItems,
      ok,
      note: ok ? entry.note : entry.note || firstText(text, "description") || firstText(text, "title")
    };
  } catch (error) {
    return {
      source_name: entry.source_name,
      lang: entry.lang,
      candidate: entry.candidate === true,
      feed_items: 0,
      matching_items: 0,
      ok: false,
      error: error.message
    };
  }
}

function countFeedItems(text) {
  if (text.trim().startsWith("{")) {
    try {
      const json = JSON.parse(text);
      return Array.isArray(json.items) ? json.items.length : Array.isArray(json.articles) ? json.articles.length : 0;
    } catch {
      return 0;
    }
  }
  return (text.match(/<item[\s>]/gi) || []).length + (text.match(/<entry[\s>]/gi) || []).length;
}

function countMatchingItems(text, entry) {
  const keywords = Array.isArray(entry.include_keywords) ? entry.include_keywords : [];
  if (keywords.length === 0) return countFeedItems(text);

  const blocks = [
    ...extractBlocks(text, "item"),
    ...extractBlocks(text, "entry")
  ];

  return blocks.filter((block) => {
    const searchable = normalizeForSearch([
      firstText(block, "title"),
      firstText(block, "description"),
      firstText(block, "summary"),
      firstText(block, "content"),
      firstText(block, "content:encoded")
    ].join(" "));
    return keywords.some((keyword) => searchable.includes(normalizeForSearch(keyword)));
  }).length;
}

function extractBlocks(xml, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

function firstText(xml, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  const match = String(xml || "").match(pattern);
  return match ? cleanText(match[1]) : "";
}

function cleanText(value) {
  return decodeXml(String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function normalizeForSearch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
