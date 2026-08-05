#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const Parser = require("rss-parser");
const { serializedNews } = require("./news-hash");
const {
  closeHeadlessBrowsers,
  fetchTextWithBrowser
} = require("./headless-browser-fetch");
const {
  HISTORY_PATH,
  historyRecord,
  hostnameForURL,
  publicationRateForHosts,
  readArticleHistory,
  upsertHistoryRecord,
  writeArticleHistory
} = require("./news-history");
const {
  canonicalNewsURL,
  isScore,
  singletonClusterID,
  writeFileAtomically
} = require("./news-utils");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "feed_websites.json");
const OUTPUT_PATH = path.join(ROOT, "api", "v1", "news.json");

const SOURCE_FETCH_CONCURRENCY = 8;
const RATE_WINDOW_DAYS = 30;

const feedParser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:date", "dcDate"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["itunes:image", "itunesImage"],
      ["source", "itemSource"]
    ]
  }
});

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const maxItems = numberOr(config.max_items, 40);
  const maxItemsPerSource = numberOr(config.max_items_per_source, 8);
  const timeoutMs = numberOr(config.request_timeout_ms, 15000);
  const globalExcludeKeywords = Array.isArray(config.exclude_keywords) ? config.exclude_keywords : [];
  const sources = Array.isArray(config.sources) ? config.sources.filter((source) => source.enabled !== false) : [];

  const existingNews = await readExistingNews();
  const premium = {
    links: normalizePremiumLinks(config.premium?.links ?? config.premium_links ?? [])
  };
  const checkedAt = new Date();
  const { history, existed: historyExisted } = readArticleHistory();
  const historyBefore = JSON.stringify(history);
  const knownBefore = new Set(Object.keys(history.articles));

  const settled = await mapWithConcurrency(
    sources,
    SOURCE_FETCH_CONCURRENCY,
    async (source) => {
      const feedText = await fetchText(source.feed_url, timeoutMs);
      const parsedItems = await parseFeed(feedText, source);
      const acceptedItems = parsedItems.filter((item) => matchesSourceFilters(item, source, globalExcludeKeywords));
      const keptItems = acceptedItems.slice(0, maxItemsPerSource);

      logSourceResult(source, {
        parsedCount: parsedItems.length,
        acceptedCount: acceptedItems.length,
        keptCount: keptItems.length
      });

      return { acceptedItems, keptItems };
    }
  );

  const items = [];
  const sourceFetches = [];

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];

    if (result.status === "fulfilled") {
      items.push(...result.value.keptItems);
      sourceFetches[index] = {
        succeeded: true,
        acceptedItems: result.value.acceptedItems
      };
    } else {
      const fallbackItems = existingItemsForSource(existingNews, sources[index])
        .slice(0, maxItemsPerSource);
      sourceFetches[index] = {
        succeeded: false,
        acceptedItems: fallbackItems
      };

      if (fallbackItems.length > 0) {
        console.warn(`Keeping ${fallbackItems.length} existing item(s) for ${sourceLabel(sources[index])} - ${result.reason?.message ?? result.reason}`);
        items.push(...fallbackItems);
      } else {
        console.warn(`Skipping ${sourceLabel(sources[index])} - ${result.reason?.message ?? result.reason}`);
      }
    }
  }

  for (const fetchResult of sourceFetches) {
    if (!fetchResult?.succeeded) continue;
    for (const article of fetchResult.acceptedItems) {
      upsertHistoryRecord(history, article, checkedAt, {
        bootstrap: !historyExisted
      });
    }
  }

  const rankedItems = dedupeByUrl(items)
    .filter((item) => historyRecord(history, item.url)?.marketing !== true)
    .sort(compareNewsPriority)
    .slice(0, maxItems);

  await attachArticleMetadata(rankedItems, existingNews, history, checkedAt, timeoutMs);

  const existingItemsByURL = new Map(
    (Array.isArray(existingNews?.items) ? existingNews.items : [])
      .map((item) => [canonicalNewsURL(item.url), item])
  );
  const newsItems = rankedItems.map((item) => {
    const output = {
      title: item.title,
      url: item.url,
      image: item.image,
      peek_preview: item.peek_preview,
      source_name: item.source_name,
      lang: item.lang,
      featured: item.featured,
      published_at: item.published_at
    };

    return preserveEvaluationMetadata(
      output,
      existingItemsByURL.get(canonicalNewsURL(item.url))
    );
  });

  for (const article of newsItems) {
    const key = canonicalNewsURL(article.url);
    const previousItem = existingItemsByURL.get(key);
    const record = upsertHistoryRecord(history, article, checkedAt, {
      bootstrap: !historyExisted
    });
    record.scoring_pending = article.score_quality === -1
      || article.score_notif === -1;
    record.clustering_pending = !knownBefore.has(key)
      || record.clustering_pending === true
      || typeof previousItem?.cluster !== "string"
      || !previousItem.cluster.trim()
      || typeof previousItem?.cluster_main !== "boolean";
  }

  const sourceCatalog = sources.map((source, index) => buildSourceMetadata({
    source,
    fetchResult: sourceFetches[index],
    existingNews,
    checkedAt,
    history,
    historyExisted,
    knownBefore
  }));

  const stableSources = sourceCatalog.map(({ source_name, lang }) => ({ source_name, lang }));
  const previousStableSources = (Array.isArray(existingNews?.sources) ? existingNews.sources : [])
    .map(({ source_name, lang }) => ({ source_name, lang }));
  const meaningfulChange = JSON.stringify(newsItems) !== JSON.stringify(existingNews?.items ?? [])
    || JSON.stringify(premium) !== JSON.stringify(existingNews?.premium ?? { links: [] })
    || JSON.stringify(stableSources) !== JSON.stringify(previousStableSources)
    || JSON.stringify(history) !== historyBefore;

  if (!meaningfulChange) {
    console.log("No article, premium, source-catalog, or history changes; leaving generated files untouched");
    return;
  }

  const news = {
    last_updated: checkedAt.toISOString(),
    premium,
    sources: sourceCatalog,
    items: newsItems
  };

  writeFileAtomically(OUTPUT_PATH, serializedNews(news));
  writeArticleHistory(history, HISTORY_PATH);
  console.log(`Wrote ${news.items.length} news item(s) to ${path.relative(ROOT, OUTPUT_PATH)}`);
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = {
            status: "fulfilled",
            value: await operation(values[index], index)
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// Fetch with a real browser network stack. Chrome gets one navigation; Firefox
// gets one navigation only when Chrome fails or returns an invalid body. Each
// browser process is shared for the whole run, and all subresources are blocked,
// making two browser navigation attempts per publisher URL the hard maximum.
async function fetchText(url, timeoutMs, options = {}) {
  const validate = options.validate ?? looksLikeFeed;
  const label = options.label ?? "feed";
  const browserFetch = options.browserFetch ?? fetchTextWithBrowser;
  const startedAt = Date.now();

  console.log(`  [fetch] start ${label} ${url}`);
  const done = (via, text) => {
    console.log(`  [fetch] ok ${label} via ${via} in ${Date.now() - startedAt}ms, ${text.length} bytes: ${url}`);
    return text;
  };

  const failures = [];
  for (const engine of ["chrome", "firefox"]) {
    try {
      const result = await browserFetch(url, { engine, timeoutMs });
      if (!result) {
        failures.push(`${engine} unavailable`);
        continue;
      }
      if (validate(result.text)) return done(engine, result.text);

      const preview = result.text.trim().slice(0, 120).replace(/\s+/g, " ");
      failures.push(`${engine} returned an invalid ${label}`);
      console.warn(
        `  [browser] ${engine} response did not look like ${label} for ${url} (${result.text.length} bytes): ${preview}`
      );
    } catch (error) {
      failures.push(`${engine}: ${error?.message ?? error}`);
      console.warn(`  [browser] ${engine} failed for ${url}: ${error?.message ?? error}`);
    }
  }

  console.warn(`  [fetch] giving up on ${label} after ${Date.now() - startedAt}ms: ${url}`);
  throw new Error(`Chrome and Firefox did not return a valid ${label}: ${failures.join("; ")}`);
}

function looksLikeFeed(text) {
  const trimmed = (text || "").trim();
  return /<(rss|feed|channel|item|entry)\b/i.test(trimmed) || trimmed.startsWith("{");
}

// A usable HTML article page: substantial body with at least one paragraph.
// Rejects short 403/challenge pages that some sites return with a 200 status.
function looksLikeArticleHtml(text) {
  const trimmed = (text || "").trim();
  return trimmed.length > 1000 && /<p[\s>]/i.test(trimmed);
}

const ARTICLE_METADATA_FETCH_CONCURRENCY = 8;

// Fill in social images missing from the feed, reusing the previous news.json
// before fetching an article page. Reading time is intentionally not estimated:
// the title-only analysis pipeline does not read or retain full article text.
async function attachArticleMetadata(items, existingNews, history, checkedAt, timeoutMs) {
  const cached = new Map();
  for (const item of Array.isArray(existingNews?.items) ? existingNews.items : []) {
    cached.set(canonicalNewsURL(item.url), item);
  }

  const toFetch = [];
  for (const item of items) {
    const cachedItem = cached.get(canonicalNewsURL(item.url));
    const record = historyRecord(history, item.url);
    if (!item.image && cachedItem?.image) {
      item.image = cachedItem.image;
    }
    const needsImage = !item.image && record?.skip_image_lookup !== true;
    if (needsImage) {
      toFetch.push(item);
    }
  }

  if (toFetch.length === 0) {
    console.log("Article metadata: all images covered by feed content or cache");
    return;
  }

  const missingImages = toFetch.filter((item) =>
    !item.image && historyRecord(history, item.url)?.skip_image_lookup !== true
  ).length;
  console.log(
    `Article metadata: fetching ${toFetch.length} page(s) with concurrency ${ARTICLE_METADATA_FETCH_CONCURRENCY}; missing images=${missingImages}`
  );

  let cursor = 0;
  let resolvedImages = 0;
  let unresolvedImages = 0;
  const workers = Array.from({ length: Math.min(ARTICLE_METADATA_FETCH_CONCURRENCY, toFetch.length) }, async () => {
    while (cursor < toFetch.length) {
      const item = toFetch[cursor];
      cursor += 1;
      const record = upsertHistoryRecord(history, item, checkedAt);
      const needsImage = !item.image && record.skip_image_lookup !== true;

      try {
        const page = await fetchArticlePage(item.url, timeoutMs);
        if (needsImage) {
          const image = page ? absolutize(extractPageImage(page), item.url) : null;
          if (image) {
            item.image = image;
            delete record.skip_image_lookup;
            resolvedImages += 1;
            console.log(`  [image] resolved for ${item.url}`);
          } else {
            record.skip_image_lookup = true;
            unresolvedImages += 1;
            console.warn(
              `  [image] missing for ${item.url} (page ${page ? "has no social image" : "unreachable"})`
            );
          }
        }
      } catch (error) {
        if (needsImage) {
          record.skip_image_lookup = true;
          unresolvedImages += 1;
        }
        console.warn(`  [metadata] failed for ${item.url} - ${error?.message ?? error}`);
      }
    }
  });

  await Promise.all(workers);
  console.log(
    `Article metadata: images resolved=${resolvedImages}, unresolved=${unresolvedImages}`
  );
}

function extractPageImage(html) {
  const metaTags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  const priorities = [
    "og:image",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src"
  ];

  for (const key of priorities) {
    for (const tag of metaTags) {
      const attributes = htmlTagAttributes(tag);
      const property = (attributes.property || attributes.name || "").toLowerCase();
      if (property === key && attributes.content) {
        return decodeXml(attributes.content).trim();
      }
    }
  }

  const linkTags = String(html || "").match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const attributes = htmlTagAttributes(tag);
    const rel = String(attributes.rel || "").toLowerCase().split(/\s+/);
    if (rel.includes("image_src") && attributes.href) {
      return decodeXml(attributes.href).trim();
    }
  }

  return "";
}

function htmlTagAttributes(tag) {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (const match of String(tag || "").matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = match[3];
  }
  return attributes;
}

// Fetch a full HTML article page through the same Chrome → Firefox path as
// feeds, validating for an article-shaped HTML body so challenge pages are
// rejected. Returns null on failure so callers can skip the item gracefully.
async function fetchArticlePage(url, timeoutMs) {
  try {
    return await fetchText(url, timeoutMs, {
      validate: looksLikeArticleHtml,
      label: "article"
    });
  } catch {
    return null;
  }
}

async function parseFeed(feedText, source) {
  const trimmed = feedText.trim();

  if (trimmed.startsWith("{")) {
    return parseJsonFeed(trimmed, source);
  }
  const feed = await feedParser.parseString(trimmed);
  return (Array.isArray(feed.items) ? feed.items : [])
    .map((item) => normalizeParsedFeedItem(item, source))
    .filter(Boolean);
}

async function readExistingNews() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function existingItemsForSource(existingNews, source) {
  const items = Array.isArray(existingNews?.items) ? existingNews.items : [];
  const sourceName = source.source_name || "";
  const lang = normalizeLang(source.lang);

  return items.filter((item) => item.source_name === sourceName && normalizeLang(item.lang) === lang);
}

function preserveEvaluationMetadata(item, previousItem) {
  if (isScore(previousItem?.score_quality)
      && isScore(previousItem?.score_notif)) {
    item.score_quality = previousItem.score_quality;
    item.score_notif = previousItem.score_notif;
  } else {
    item.score_quality = -1;
    item.score_notif = -1;
  }
  if (typeof previousItem?.cluster === "string" && previousItem.cluster.trim()) {
    item.cluster = previousItem.cluster.trim();
  } else {
    item.cluster = singletonClusterID(item);
  }
  item.cluster_main = typeof previousItem?.cluster_main === "boolean"
    ? previousItem.cluster_main
    : true;
  return item;
}

function logSourceResult(source, { parsedCount, acceptedCount, keptCount }) {
  console.log(`${sourceLabel(source)} - parsed ${parsedCount}, accepted ${acceptedCount}, kept ${keptCount}`);
}

function sourceLabel(source) {
  const feedUrl = source?.feed_url || "";
  const sourceName = source?.source_name || (feedUrl ? new URL(feedUrl).hostname : "Unknown");

  return `${sourceName} [${normalizeLang(source?.lang)}] url=${feedUrl}`;
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

function normalizeParsedFeedItem(item, source) {
  const content = item.contentEncoded
    ?? item["content:encoded"]
    ?? item.content
    ?? item.summary
    ?? item.description
    ?? "";
  const preview = item.contentSnippet
    ?? item.summary
    ?? item.description
    ?? content;
  return normalizeItem({
    title: item.title,
    url: item.link ?? item.guid ?? item.id,
    image: parsedFeedImage(item, content),
    previewHtml: preview,
    publishedAt: item.isoDate
      ?? item.pubDate
      ?? item.published
      ?? item.updated
      ?? item.dcDate,
    itemSourceName: parsedSourceName(item.itemSource ?? item.source),
    source
  });
}

function parsedFeedImage(item, content) {
  const candidates = [
    item.mediaContent,
    item["media:content"],
    item.mediaThumbnail,
    item["media:thumbnail"],
    item.itunesImage,
    item["itunes:image"],
    item.enclosure
  ].flatMap((value) => Array.isArray(value) ? value : [value]);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const type = String(candidate.type ?? candidate.$?.type ?? "").toLowerCase();
    if (type.startsWith("audio/") || type.startsWith("video/")) continue;
    const url = candidate.url
      ?? candidate.href
      ?? candidate.$?.url
      ?? candidate.$?.href;
    if (url) return String(url);
  }
  return firstImageFromHtml(content);
}

function parsedSourceName(value) {
  if (typeof value === "string") return value;
  if (typeof value?._ === "string") return value._;
  if (typeof value?.value === "string") return value.value;
  return "";
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
    const key = canonicalNewsURL(item.url);

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

function buildSourceMetadata({
  source,
  fetchResult,
  existingNews,
  checkedAt,
  history,
  historyExisted,
  knownBefore
}) {
  const sourceName = cleanText(source.source_name) || new URL(source.feed_url).hostname;
  const language = normalizeLang(source.lang);
  const previousSource = (Array.isArray(existingNews?.sources) ? existingNews.sources : []).find(
    (entry) => entry.source_name === sourceName && normalizeLang(entry.lang) === language
  );
  const acceptedItems = dedupeByUrl(fetchResult?.acceptedItems ?? []);
  const latestTimestamp = acceptedItems.reduce(
    (latest, item) => {
      const timestamp = Date.parse(item.published_at || "");
      return Number.isFinite(timestamp) && timestamp <= checkedAt.getTime() + 5 * 60 * 1_000
        ? Math.max(latest, timestamp)
        : latest;
    },
    Date.parse(previousSource?.latest_article_at || "") || 0
  );
  if (!fetchResult?.succeeded) {
    return {
      source_name: sourceName,
      lang: language,
      estimated_articles_per_day: Number(previousSource?.estimated_articles_per_day) || 0,
      new_articles_since_last_update: previousSource?.new_articles_since_last_update ?? null,
      latest_article_at: latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : null
    };
  }

  const hostnames = new Set(acceptedItems.map((item) => hostnameForURL(item.url)).filter(Boolean));
  const newArticleCount = historyExisted
    ? acceptedItems.filter((item) => !knownBefore.has(canonicalNewsURL(item.url))).length
    : null;
  return {
    source_name: sourceName,
    lang: language,
    estimated_articles_per_day: roundNumber(
      publicationRateForHosts(history, hostnames, checkedAt, RATE_WINDOW_DAYS),
      1
    ),
    new_articles_since_last_update: newArticleCount,
    latest_article_at: latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : null
  };
}

function roundNumber(value, fractionDigits) {
  const scale = 10 ** fractionDigits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
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

function matchesSourceFilters(item, source, globalExcludeKeywords = []) {
  const haystack = normalizeForSearch([
    item.title,
    item.peek_preview,
    item.source_name
  ].filter(Boolean).join(" "));

  const includeKeywords = Array.isArray(source.include_keywords) ? source.include_keywords : [];

  if (includeKeywords.length > 0 && !includeKeywords.some((keyword) => haystack.includes(normalizeForSearch(keyword)))) {
    return false;
  }

  const excludeKeywords = [
    ...(Array.isArray(source.exclude_keywords) ? source.exclude_keywords : []),
    ...globalExcludeKeywords
  ];

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

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(closeHeadlessBrowsers);
}

module.exports = {
  attachArticleMetadata,
  buildSourceMetadata,
  extractPageImage,
  fetchText,
  preserveEvaluationMetadata
};
