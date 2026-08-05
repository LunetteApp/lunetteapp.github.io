const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "mc_cid",
  "mc_eid",
  "ref_src"
]);

function canonicalNewsURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return raw.replace(/#.*$/, "");
  }
}

function compactArticleID(url) {
  return `a_${crypto
    .createHash("sha256")
    .update(canonicalNewsURL(url))
    .digest("hex")
    .slice(0, 12)}`;
}

function singletonClusterID(article) {
  const timestamp = Date.parse(article?.published_at || "");
  const day = Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "")
    : "undated";
  const hash = crypto
    .createHash("sha256")
    .update(canonicalNewsURL(article?.url))
    .digest("hex")
    .slice(0, 12);
  return `${day}-${hash}`;
}

function isScore(value) {
  return value === -1
    || (Number.isInteger(value) && value >= 0 && value <= 100);
}

function writeFileAtomically(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

module.exports = {
  canonicalNewsURL,
  compactArticleID,
  isScore,
  singletonClusterID,
  writeFileAtomically
};
