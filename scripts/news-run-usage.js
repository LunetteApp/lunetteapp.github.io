const fs = require("node:fs");
const { writeFileAtomically } = require("./news-utils");

function emptyRunUsage(model = process.env.LLM_MODEL || "gpt-5.4") {
  return { model, status: "not_started", input: 0, output: 0, cost: 0, calls: 0, priced: true };
}

function saveRunUsage(filePath, usage) {
  if (filePath) writeFileAtomically(filePath, `${JSON.stringify(usage)}\n`);
}

function formatRunUsage(usage) {
  // A failed request with no reported usage must not look like a free request.
  const unknown = usage.usageUnknown || usage.input == null || usage.output == null
    || (usage.status === "failed" && usage.calls === 0);
  const cost = !unknown && (usage.calls === 0 || usage.priced) && Number.isFinite(usage.cost)
    ? usage.cost.toFixed(6) : "unknown";
  const model = String(usage.model).replace(/[\r\n]/g, " ");
  return `NEWS_USAGE model=${model} status=${usage.status} calls=${usage.calls ?? "unknown"} reported_tokens_in=${unknown ? "unknown" : usage.input} reported_tokens_out=${unknown ? "unknown" : usage.output} reported_tokens_total=${unknown ? "unknown" : usage.input + usage.output} estimated_cost_usd=${cost}`;
}

function printWorkflowUsage(env = process.env) {
  let usage;
  if (env.NEWS_USAGE_PATH && fs.existsSync(env.NEWS_USAGE_PATH)) {
    usage = JSON.parse(fs.readFileSync(env.NEWS_USAGE_PATH, "utf8"));
    if (["failure", "cancelled"].includes(env.NEWS_ANALYSIS_OUTCOME)) usage.status = "failed";
  } else if (["success", "failure", "cancelled"].includes(env.NEWS_ANALYSIS_OUTCOME)) {
    usage = { ...emptyRunUsage(env.LLM_MODEL), status: "failed", input: null, output: null, cost: null, calls: null };
  } else {
    usage = { ...emptyRunUsage(env.LLM_MODEL), status: "skipped" };
  }
  const line = formatRunUsage(usage);
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### News API usage\n\n\`\`\`text\n${line}\n\`\`\`\n\nCost is a standard-rate estimate before free allowances or credits. Tokens include reasoning output and reported retry usage.\n`);
  }
  return line;
}

if (require.main === module) printWorkflowUsage();

module.exports = { emptyRunUsage, saveRunUsage, formatRunUsage, printWorkflowUsage };
