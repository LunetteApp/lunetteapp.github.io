const { execFile } = require("node:child_process");
const { priceForModel } = require("./llm-prices");

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_ATTEMPTS = 3;
const MAX_STRUCTURED_ATTEMPTS = 2;
const HEARTBEAT_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

function resolveLLMConfig(env = process.env) {
  const apiKey = env.LLM_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || null;
  if (!apiKey) {
    throw new Error("LLM_API_KEY or OPENAI_API_KEY is required to reach the OpenAI API");
  }

  const model = env.LLM_MODEL?.trim() || DEFAULT_MODEL;
  return {
    model,
    baseURL: resolveBaseURL(env.LLM_URL?.trim() || env.OPENAI_BASE_URL?.trim()),
    cliPath: env.LLM_CLI_PATH?.trim() || "openai",
    apiKey,
    // Clustering and ranking 120 multilingual titles in one response benefits
    // from the model's balanced reasoning setting.
    reasoningEffort: env.LLM_REASONING_EFFORT?.trim().toLowerCase() || "medium",
    prices: resolvePrices(env, model)
  };
}

// LLM_URL historically names the complete Chat Completions endpoint. The CLI
// takes a base URL and adds /chat/completions itself; accept both forms.
function resolveBaseURL(value = DEFAULT_BASE_URL) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The OpenAI base URL must not contain credentials, query parameters or fragments");
  }
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

// The API reports tokens, never money, so cost is computed here. Rates come from
// the model's own entry in the price table; the environment overrides it, which
// covers a new model and a price change before this repo hears about either.
function resolvePrices(env, model) {
  const rate = (value) => {
    const text = value?.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const listed = priceForModel(model);
  const input = rate(env.LLM_PRICE_INPUT) ?? listed?.input ?? null;
  const output = rate(env.LLM_PRICE_OUTPUT) ?? listed?.output ?? null;
  if (input === null || output === null) return null;
  // A model without a cache discount bills cached tokens at the full rate.
  const cachedInput = rate(env.LLM_PRICE_CACHED_INPUT)
    ?? listed?.cachedInput
    ?? input;
  return { input, output, cachedInput };
}

function createLLMProvider({
  env = process.env,
  runCLIFunction = runOpenAICLI,
  sleepFunction = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = () => {}
} = {}) {
  const config = resolveLLMConfig(env);

  // Retries and correction attempts each bill separately, so a run's real cost
  // is the total of every call rather than the one that finally succeeded.
  const spend = { cost: 0, input: 0, output: 0, calls: 0 };

  // The key is deliberately not part of the returned object: callers log the
  // provider's fields, and a spread would put it one console.log away.
  return {
    model: config.model,
    baseURL: config.baseURL,
    reasoningEffort: config.reasoningEffort,
    request: (request) => requestWithRetry(
      { ...request, reasoningEffort: config.reasoningEffort },
      config,
      { runCLIFunction, env, sleepFunction, logger, spend }
    ),
    totalSpend: () => ({
      ...spend,
      priced: config.prices !== null,
      formatted: config.prices === null
        ? "cost unpriced"
        : `~$${formatUSD(spend.cost)}`
    })
  };
}

// The schema bounds the model cannot be forced to honour — an array of exactly
// one pair per headline — are checked here, and a failure is sent back as a
// correction rather than losing the whole run.
async function requestStructuredOutput(
  request,
  { requestFunction, parse, validate, correction, log = () => {} }
) {
  let currentRequest = request;
  let lastError;
  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt += 1) {
    log(`Structured-output attempt ${attempt}/${MAX_STRUCTURED_ATTEMPTS}`);
    const response = await requestFunction(currentRequest);

    try {
      const parsed = parse(JSON.parse(response.message.content));
      validate(parsed);
      return parsed;
    } catch (error) {
      lastError = error;
      log(`Structured-output attempt ${attempt} failed: ${error.message}`);
      log(`LLM output for attempt ${attempt}:\n${response.message.content}`);
      if (attempt === MAX_STRUCTURED_ATTEMPTS) break;
      currentRequest = {
        ...request,
        messages: [
          ...request.messages,
          {
            role: "user",
            content: `Correction: ${correction} Validation error: ${error.message}`
          }
        ]
      };
    }
  }
  throw lastError;
}

function buildRequest(request) {
  const body = {
    model: request.model,
    messages: request.messages,
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "lunette_result",
        // Strict mode rejects minItems, maxItems, and uniqueItems, which are
        // exactly the bounds these schemas rely on. The shape is validated and
        // corrected on this side instead.
        strict: false,
        schema: request.outputSchema
      }
    }
  };
  if (Number.isInteger(request.maxOutputTokens)) {
    body.max_completion_tokens = request.maxOutputTokens;
  }
  if (request.reasoningEffort) {
    body.reasoning_effort = request.reasoningEffort;
  }

  return body;
}

// JSON goes through stdin, never a shell. Keep credentials in the child's
// environment and bound both its runtime and captured output.
function runOpenAICLI({ binary, args, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, {
      env, timeout: timeoutMs, killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024, encoding: "utf8", shell: false
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      let message;
      if (error.code === "ENOENT") {
        message = "OpenAI CLI not found; install openai or set LLM_CLI_PATH";
      } else if (error.killed) {
        message = `OpenAI CLI exceeded its ${formatDuration(timeoutMs)} timeout`;
      } else {
        message = `OpenAI CLI failed (${error.code ?? error.signal ?? "unknown"}): ${errorMessage(parseErrorBody(stderr))}`;
      }
      reject(new Error(redactKeys(message, env.OPENAI_API_KEY)));
    });
    // A CLI argument/auth error can close stdin before the body is written.
    // The execFile callback reports the process failure without an uncaught EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function requestWithRetry(
  request,
  config,
  { runCLIFunction, env, sleepFunction, logger, spend }
) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = Date.now();
    logger("openai", `Attempt ${attempt}/${MAX_ATTEMPTS} started`);
    const heartbeat = setInterval(() => {
      logger(
        "openai",
        `Attempt ${attempt}/${MAX_ATTEMPTS} running for ${formatDuration(Date.now() - attemptStartedAt)}`
      );
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    try {
      const response = await runCLIFunction({
        binary: config.cliPath,
        args: ["chat:completions", "create", "--format", "json", "--format-error", "json"],
        env: {
          ...env,
          OPENAI_API_KEY: config.apiKey,
          OPENAI_BASE_URL: config.baseURL,
          OPENAI_UNTRUSTED_STDIN: "1",
          OPENAI_CLI_NO_UPDATE_CHECK: "1"
        },
        input: `${JSON.stringify(buildRequest(request))}\n`,
        timeoutMs: REQUEST_TIMEOUT_MS
      });
      const result = readResponse(response.stdout, config.prices, spend);
      logger(
        "openai",
        `Attempt ${attempt}/${MAX_ATTEMPTS} completed in ${formatDuration(Date.now() - attemptStartedAt)}; ${result.usage}`
      );
      return result;
    } catch (error) {
      lastError = new Error(describeError(error, config.apiKey));
      logger(
        "openai",
        `Attempt ${attempt}/${MAX_ATTEMPTS} failed after ${formatDuration(Date.now() - attemptStartedAt)}: ${describeError(error, config.apiKey)}`
      );
      if (!isRetryableError(error)) {
        logger("openai", "Failure is not retryable");
        break;
      }
      if (attempt === MAX_ATTEMPTS) {
        logger("openai", "Retry limit reached");
        break;
      }
      const retryDelay = attempt * 2_000;
      logger("openai", `Retrying in ${formatDuration(retryDelay)}`);
      await sleepFunction(retryDelay);
    } finally {
      clearInterval(heartbeat);
    }
  }
  throw lastError;
}

// The CLI's SDK owns HTTP/network retries. Only retry a successful invocation
// with an unusable model response here, avoiding multiplied transport attempts.
function isRetryableError(error) {
  return error?.retryable === true;
}

function readResponse(responseText, prices, spend) {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw retryableError("OpenAI response contained invalid JSON");
  }

  // Billed before it is useful: a reply that spent its budget reasoning costs
  // the same as one that answered, so it is recorded ahead of the content check.
  recordSpend(spend, payload?.usage, prices);

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    // A reasoning model that spends its whole budget thinking returns an empty
    // message with this finish reason rather than an error.
    if (choice?.finish_reason === "length") {
      throw retryableError("OpenAI hit the output token limit before answering");
    }
    throw retryableError("OpenAI response did not contain assistant content");
  }

  return {
    message: { content },
    usage: formatUsage(payload?.usage, prices)
  };
}

function formatUsage(usage, prices) {
  if (!usage) return "usage unknown";
  const { input, output, cached } = tokenCounts(usage);
  const parts = [`tokens in=${input ?? "?"} out=${output ?? "?"}`];
  if (cached > 0) parts.push(`cached=${cached}`);
  const cost = estimateCost({ input, output, cached }, prices);
  parts.push(cost === null ? "cost unpriced" : `cost ~$${formatUSD(cost)}`);
  return parts.join(" ");
}

function tokenCounts(usage) {
  return {
    input: usage?.prompt_tokens,
    output: usage?.completion_tokens,
    cached: usage?.prompt_tokens_details?.cached_tokens ?? 0
  };
}

function recordSpend(spend, usage, prices) {
  if (!spend) return;
  const counts = tokenCounts(usage);
  spend.calls += 1;
  if (Number.isFinite(counts.input)) spend.input += counts.input;
  if (Number.isFinite(counts.output)) spend.output += counts.output;
  const cost = estimateCost(counts, prices);
  if (cost !== null) spend.cost += cost;
}

function estimateCost({ input, output, cached }, prices) {
  if (!prices || !Number.isFinite(input) || !Number.isFinite(output)) return null;
  // Cached input tokens are billed at their own lower rate and are already
  // counted inside prompt_tokens, so they are priced out of the full amount.
  const freshInput = Math.max(0, input - cached);
  return (freshInput * prices.input
    + cached * prices.cachedInput
    + output * prices.output) / 1_000_000;
}

function formatUSD(cost) {
  return cost < 0.01 ? cost.toFixed(5) : cost.toFixed(4);
}

function parseErrorBody(responseText) {
  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

function errorMessage(body) {
  const text = typeof body === "string"
    ? body.slice(0, 300) || "no response body"
    : body?.error?.message || JSON.stringify(body).slice(0, 300);
  return redactKeys(text);
}

// An upstream error can quote the request it rejected, and these logs are
// public on a workflow run.
function redactKeys(text, apiKey) {
  const redacted = String(text).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
  return apiKey ? redacted.split(apiKey).join("[redacted]") : redacted;
}

function describeError(error, apiKey) {
  return redactKeys(`${error?.name ?? "Error"}: ${error?.message ?? error}`, apiKey);
}

function retryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

module.exports = {
  createLLMProvider,
  requestStructuredOutput,
  runOpenAICLI,
  resolveLLMConfig
};
