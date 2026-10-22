const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { emptyRunUsage, saveRunUsage, formatRunUsage } = require("../news-run-usage");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "news-run-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { NEWS_USAGE_PATH: path.join(root, "usage.json"), GITHUB_STEP_SUMMARY: path.join(root, "summary.md"), LLM_MODEL: "gpt-5.4" };
}

function report(env) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "../news-run-usage.js")], {
    env: { ...process.env, ...env }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("a skipped workflow prints zero usage and writes the same line to the job summary", t => {
  const env = fixture(t);
  const line = report({ ...env, NEWS_ANALYSIS_OUTCOME: "skipped" });
  assert.match(line, /status=skipped calls=0 reported_tokens_in=0 reported_tokens_out=0 reported_tokens_total=0 estimated_cost_usd=0\.000000/);
  assert.ok(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8").includes(line.trim()));
});

test("the final workflow step retains billed retry usage when analysis fails", t => {
  const env = fixture(t);
  saveRunUsage(env.NEWS_USAGE_PATH, { ...emptyRunUsage(), status: "running", input: 200, output: 40, calls: 2, cost: 0.00092 });
  const line = report({ ...env, NEWS_ANALYSIS_OUTCOME: "failure" });
  assert.match(line, /status=failed calls=2 reported_tokens_in=200 reported_tokens_out=40 reported_tokens_total=240 estimated_cost_usd=0\.000920/);
});

test("unavailable usage and unpriced responses are not presented as free requests", t => {
  const env = fixture(t);
  assert.match(report({ ...env, NEWS_ANALYSIS_OUTCOME: "failure" }), /reported_tokens_in=unknown.*estimated_cost_usd=unknown/);
  assert.match(formatRunUsage({ ...emptyRunUsage("custom-model"), status: "success", input: 20, output: 10, calls: 1, priced: false }), /reported_tokens_in=20.*estimated_cost_usd=unknown/);
  assert.match(formatRunUsage({ ...emptyRunUsage(), status: "success", calls: 1, usageUnknown: true }), /reported_tokens_in=unknown.*estimated_cost_usd=unknown/);
});
