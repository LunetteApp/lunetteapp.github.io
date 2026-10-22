const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

function previews(values) {
  return JSON.parse(execFileSync("python3", [path.join(__dirname, "../news-preview.py")], {
    input: JSON.stringify(values), encoding: "utf8"
  }));
}

test("preview preparation retains short text, normalizes whitespace and removes URLs", () => {
  assert.deepEqual(previews([
    null, "", "  First-hand\nreview of the movement.  ",
    "Live photos: HTTPS://example.com/tracking"
  ]), ["none", "none", "First-hand review of the movement.", "Live photos: [link]"]);
});

test("long previews are marked and cut at whole words within the approximate budget", () => {
  const original = "Independent reporting about the movement and its hand finishing. ".repeat(8);
  const [result] = previews([original]);
  assert.ok(result.endsWith("…"));
  const prefix = result.slice(0, -1);
  assert.ok(original.startsWith(prefix));
  assert.ok(/[\s.,;:]/.test(original[prefix.length]));
  assert.ok(result.length <= 160);
});

test("wide-script previews have a smaller character budget and retain Unicode", () => {
  const original = "機械式時計の新作を紹介します。".repeat(20);
  const [result, emoji] = previews([original, "🕰️ Watch review"]);
  assert.ok(result.endsWith("…"));
  assert.ok(original.startsWith(result.slice(0, -1)));
  assert.ok(Array.from(result).length <= 40);
  assert.ok(!result.includes("�"));
  assert.equal(emoji, "🕰️ Watch review");
});
