#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "feed_websites.json");
const OUTPUT_PATH = path.join(ROOT, "api", "v1", "news.json");
const USER_AGENT = "LunetteNewsBot/1.0 (+https://lunetteapp.com)";

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const maxItems = numberOr(config.max_items, 40);
  const maxItemsPerSource = numberOr(config.max_items_per_source, 8);
  const timeoutMs = numberOr(config.request_timeout_ms, 15000);
  const sources = Array.isArray(config.sources) ? config.sources.filter((source) => source.enabled !== false) : [];
  const premiumLinks = normalizePremiumLinks(config.premium?.links ?? config.premium_links ?? []);

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const feedText = await fetchText(source.feed_url, timeoutMs);
      return parseFeed(feedText, source)
        .filter((item) => matchesSourceFilters(item, source))
        .slice(0, maxItemsPerSource);
    })
  );

  const items = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const sourceName = sources[index]?.source_name ?? sources[index]?.feed_url ?? "Unknown";
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      console.warn(`Skipping ${sourceName}: ${result.reason?.message ?? result.reason}`);
    }
  }

  const premium = {
    links: premiumLinks
  };
  const newsItems = dedupeByUrl(items)
    .sort(compareNewsPriority)
    .slice(0, maxItems)
    .map((item) => ({
      title: item.title,
      url: item.url,
      image: item.image,
      peek_preview: item.peek_preview,
      source_name: item.source_name,
      lang: item.lang,
      featured: item.featured,
      published_at: item.published_at
    }));
  const contentHash = sha256Hex(JSON.stringify({ premium, items: newsItems }));

  const news = {
    last_updated: new Date().toISOString(),
    content_hash: contentHash,
    premium,
    items: newsItems
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(news, null, 2)}\n`);
  console.log(`Wrote ${news.items.length} news item(s) to ${path.relative(ROOT, OUTPUT_PATH)}`);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml;q=0.9, */*;q=0.5" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseFeed(feedText, source) {
  const trimmed = feedText.trim();
  if (trimmed.startsWith("{")) {
    return parseJsonFeed(trimmed, source);
  }
  if (/<entry[\s>]/i.test(trimmed)) {
    return parseAtom(trimmed, source);
  }
  return parseRss(trimmed, source);
}

function parseJsonFeed(text, source) {
  const feed = JSON.parse(text);
  const items = Array.isArray(feed.items) ? feed.items : [];
  return items.map((item) => normalizeItem({
    title: item.title,
    url: item.url ?? item.external_url,
    image: item.image ?? item.banner_image,
    previewHtml: item.summary ?? item.content_text ?? item.content_html,
    publishedAt: item.date_published ?? item.date_modified,
    source
  })).filter(Boolean);
}

function parseRss(xml, source) {
  return blocks(xml, "item").map((itemXml) => normalizeItem({
    title: firstText(itemXml, "title"),
    url: firstText(itemXml, "link") || firstAttr(itemXml, "guid", "href"),
    image: extractImage(itemXml),
    previewHtml: firstText(itemXml, "description") || firstText(itemXml, "content:encoded"),
    publishedAt: firstText(itemXml, "pubDate") || firstText(itemXml, "dc:date") || firstText(itemXml, "date"),
    itemSourceName: firstText(itemXml, "source"),
    source
  })).filter(Boolean);
}

function parseAtom(xml, source) {
  return blocks(xml, "entry").map((entryXml) => normalizeItem({
    title: firstText(entryXml, "title"),
    url: atomLink(entryXml),
    image: extractImage(entryXml),
    previewHtml: firstText(entryXml, "summary") || firstText(entryXml, "content"),
    publishedAt: firstText(entryXml, "published") || firstText(entryXml, "updated"),
    source
  })).filter(Boolean);
}

function normalizeItem({ title, url, image, previewHtml, publishedAt, itemSourceName, source }) {
  const resolvedSourceName = source.use_item_source_name && itemSourceName
    ? cleanText(itemSourceName)
    : source.source_name || new URL(source.feed_url).hostname;
  const cleanTitle = cleanNewsTitle(cleanText(title), resolvedSourceName);
  const absoluteUrl = absolutize(url, source.feed_url);
  if (!cleanTitle || !absoluteUrl) return null;

  const preview = truncate(cleanText(previewHtml), 220);
  const published = parseDate(publishedAt);
  const featured = isFeatured(cleanTitle, preview, source);

  return {
    title: cleanTitle,
    url: absoluteUrl,
    image: absolutize(image, absoluteUrl),
    peek_preview: preview,
    source_name: resolvedSourceName,
    lang: normalizeLang(source.lang),
    featured,
    published_at: published
  };
}

function blocks(xml, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

function firstText(xml, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  const match = xml.match(pattern);
  return match ? decodeXml(stripCdata(match[1])).trim() : "";
}

function firstAttr(xml, tagName, attrName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*\\s${escapeRegExp(attrName)}=["']([^"']+)["'][^>]*>`, "i");
  const match = xml.match(pattern);
  return match ? decodeXml(match[1]).trim() : "";
}

function atomLink(xml) {
  const alternate = xml.match(/<link\b(?=[^>]*\brel=["']alternate["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  if (alternate) return decodeXml(alternate[1]).trim();
  const anyHref = xml.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  if (anyHref) return decodeXml(anyHref[1]).trim();
  return firstText(xml, "link");
}

function extractImage(xml) {
  return firstAttr(xml, "media:content", "url")
    || firstAttr(xml, "media:thumbnail", "url")
    || firstAttr(xml, "enclosure", "url")
    || firstAttr(xml, "itunes:image", "href")
    || firstImageFromHtml(firstText(xml, "content:encoded"))
    || firstImageFromHtml(firstText(xml, "description"))
    || firstImageFromHtml(firstText(xml, "summary"))
    || "";
}

function firstImageFromHtml(html) {
  const match = String(html || "").match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
  return match ? decodeXml(match[1]).trim() : "";
}

function cleanText(value) {
  return decodeXml(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function cleanNewsTitle(title, sourceName) {
  if (!title || !sourceName) return title;
  const suffix = ` - ${sourceName}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

function stripCdata(value) {
  return String(value || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(value) {
  return stripCdata(String(value || ""))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function absolutize(value, baseUrl) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseDate(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function dedupeByUrl(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = item.url.replace(/[#?].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function compareNewsPriority(a, b) {
  if (Boolean(a.featured) !== Boolean(b.featured)) {
    return a.featured ? -1 : 1;
  }
  const aTime = Date.parse(a.published_at || "") || 0;
  const bTime = Date.parse(b.published_at || "") || 0;
  return bTime - aTime;
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value || "";
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeLang(value) {
  const parts = String(value || "und").trim().split("-");
  if (!parts[0]) return "und";
  const normalized = parts.map((part, index) => {
    const lower = part.toLowerCase();
    if (index === 1 && lower.length === 4) {
      return `${lower[0].toUpperCase()}${lower.slice(1)}`;
    }
    return lower;
  }).join("-");
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(normalized) ? normalized : "und";
}

function normalizeLanguageList(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(normalizeLang).filter((lang) => lang !== "und"))];
}

function isFeatured(title, preview, source) {
  if (source.featured === true) return true;
  const keywords = Array.isArray(source.featured_keywords) ? source.featured_keywords : [];
  if (keywords.length === 0) return false;
  const haystack = normalizeForSearch([title, preview, source.source_name].filter(Boolean).join(" "));
  return keywords.some((keyword) => haystack.includes(normalizeForSearch(keyword)));
}

function normalizePremiumLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.map((link) => {
    const url = absolutize(link.url, "https://lunetteapp.com/");
    const from = parseDate(link.from);
    const to = parseDate(link.to);
    const languages = normalizeLanguageList(link.languages);
    const title = cleanText(link.title);
    if (!url || !from || !to || languages.length === 0 || !title) return null;
    return {
      title,
      url,
      image: absolutize(link.image, url),
      peek_preview: truncate(cleanText(link.peek_preview ?? link.description), 220),
      source_name: cleanText(link.source_name) || "Lunette",
      languages,
      featured: link.featured !== false,
      from,
      to
    };
  }).filter(Boolean);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function matchesSourceFilters(item, source) {
  const haystack = normalizeForSearch([
    item.title,
    item.peek_preview,
    item.source_name
  ].filter(Boolean).join(" "));

  const includeKeywords = Array.isArray(source.include_keywords) ? source.include_keywords : [];
  if (includeKeywords.length > 0 && !includeKeywords.some((keyword) => haystack.includes(normalizeForSearch(keyword)))) {
    return false;
  }

  const excludeKeywords = Array.isArray(source.exclude_keywords) ? source.exclude_keywords : [];
  if (excludeKeywords.some((keyword) => haystack.includes(normalizeForSearch(keyword)))) {
    return false;
  }

  return true;
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
