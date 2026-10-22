const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createLLMProvider, requestStructuredOutput, resolveLLMConfig, runOpenAICLI } = require("../llm-provider");

const env = { LLM_API_KEY: "test-secret-value", PATH: process.env.PATH };
const schema = { type: "object", properties: { scores: { type: "array", minItems: 1 } } };
const request = { model: "gpt-5.4", messages: [{ role: "user", content: "@file:///do-not-read" }], outputSchema: schema, maxOutputTokens: 16000 };
function response(content = '{"scores":[[70,60]]}', extra = {}) {
  return { stdout: JSON.stringify({
    choices: [{ message: { content }, finish_reason: content ? "stop" : "length" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    ...extra
  }) };
}

test("CLI receives the full request on stdin and credentials only in its environment", async () => {
  let invocation;
  const provider = createLLMProvider({ env, runCLIFunction: async (value) => { invocation = value; return response(); } });
  const result = await provider.request(request);
  assert.deepEqual(invocation.args, ["chat:completions", "create", "--format", "json", "--format-error", "json"]);
  assert.equal(invocation.binary, "openai");
  assert.equal(invocation.env.OPENAI_API_KEY, env.LLM_API_KEY);
  assert.equal(invocation.env.OPENAI_UNTRUSTED_STDIN, "1");
  assert.equal(invocation.env.OPENAI_BASE_URL, "https://api.openai.com/v1");
  assert.equal(invocation.timeoutMs, 300000);
  assert.ok(!invocation.args.join(" ").includes(env.LLM_API_KEY));
  assert.ok(!JSON.stringify(provider).includes(env.LLM_API_KEY));
  const body = JSON.parse(invocation.input);
  assert.deepEqual(body.messages, request.messages);
  assert.deepEqual(body.response_format.json_schema.schema, schema);
  assert.equal(body.response_format.json_schema.strict, false);
  assert.equal(body.max_completion_tokens, 16000);
  assert.equal(body.reasoning_effort, "medium");
  assert.equal(body.stream, false);
  assert.equal(result.message.content, '{"scores":[[70,60]]}');
  assert.deepEqual(provider.totalSpend(), { cost: 0.00046, input: 100, output: 20, calls: 1, priced: true, formatted: "~$0.00046" });
});

test("existing endpoint configuration and standard OpenAI environment variables work", () => {
  assert.equal(resolveLLMConfig({ ...env, LLM_URL: "https://gateway.example/v1/chat/completions/" }).baseURL, "https://gateway.example/v1");
  const config = resolveLLMConfig({ OPENAI_API_KEY: "local-key", OPENAI_BASE_URL: "http://127.0.0.1:4321/v1", LLM_CLI_PATH: "/tmp/openai" });
  assert.equal(config.apiKey, "local-key");
  assert.equal(config.cliPath, "/tmp/openai");
  assert.equal(config.baseURL, "http://127.0.0.1:4321/v1");
  assert.throws(() => resolveLLMConfig({ ...env, LLM_URL: "https://user:secret@example.com/v1" }), /must not contain credentials/);
});

test("CLI transport failures are not retried again and secrets are redacted", async () => {
  let calls = 0;
  const logs = [];
  const provider = createLLMProvider({ env, logger: (...entry) => logs.push(entry), runCLIFunction: async () => {
    calls++;
    throw new Error(`rate limit; rejected ${env.LLM_API_KEY}`);
  } });
  await assert.rejects(provider.request(request), (error) => {
    assert.ok(!error.message.includes(env.LLM_API_KEY));
    return /rate limit/.test(error.message);
  });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(logs).includes(env.LLM_API_KEY));
});

test("unusable successful responses are bounded and billed responses are counted", async () => {
  let calls = 0;
  const provider = createLLMProvider({ env, sleepFunction: async () => {}, runCLIFunction: async () => {
    calls++;
    return calls === 1 ? response("") : response();
  } });
  await provider.request(request);
  assert.equal(calls, 2);
  assert.equal(provider.totalSpend().input, 200);
  assert.equal(provider.totalSpend().calls, 2);
  let invalidCalls = 0;
  const invalid = createLLMProvider({ env, sleepFunction: async () => {}, runCLIFunction: async () => {
    invalidCalls++;
    return { stdout: "not JSON" };
  } });
  await assert.rejects(invalid.request(request), /invalid JSON/);
  assert.equal(invalidCalls, 3);
});

test("schema corrections still use the provider and retain spend from both calls", async () => {
  const inputs = [];
  const provider = createLLMProvider({ env, runCLIFunction: async (value) => {
    inputs.push(JSON.parse(value.input));
    return response(inputs.length === 1 ? '{"scores":[]}' : '{"scores":[[70,60]]}');
  } });
  await requestStructuredOutput(request, {
    requestFunction: provider.request, parse: (value) => value,
    validate: (value) => { if (!value.scores.length) throw new Error("missing scores"); },
    correction: "Include every score."
  });
  assert.match(inputs[1].messages.at(-1).content, /Correction: Include every score/);
  assert.equal(provider.totalSpend().calls, 2);
});

test("missing CLI and timed-out processes fail with actionable errors", async () => {
  const invocation = { args: [], env, input: "{}", timeoutMs: 50 };
  await assert.rejects(runOpenAICLI({ ...invocation, binary: "/does-not-exist/openai" }), /CLI not found/);
  await assert.rejects(runOpenAICLI({ ...invocation, binary: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }), /timeout/);
});

test("CLI error details cannot expose the configured credential", async () => {
  await assert.rejects(runOpenAICLI({ binary: process.execPath,
    args: ["-e", "process.stderr.write(JSON.stringify({error:{message:process.env.OPENAI_API_KEY}}));process.exit(1)"],
    env: { ...env, OPENAI_API_KEY: env.LLM_API_KEY }, input: "{}", timeoutMs: 5000
  }), (error) => !error.message.includes(env.LLM_API_KEY) && /redacted/.test(error.message));
});

test("pinned CLI preserves JSON stdin, usage and SDK retries against a local API", { skip: !process.env.OPENAI_CLI_TEST_PATH }, async (t) => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls++;
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${env.LLM_API_KEY}`);
    const parsed = JSON.parse(body);
    assert.deepEqual(parsed.messages, request.messages);
    assert.deepEqual(parsed.response_format.json_schema.schema, schema);
    res.setHeader("Content-Type", "application/json");
    if (calls === 1) {
      res.writeHead(429, { "retry-after-ms": "1" });
      return res.end(JSON.stringify({ error: { message: "retry", type: "rate_limit_error" } }));
    }
    res.end(response().stdout);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const provider = createLLMProvider({ env: { ...process.env, ...env,
    LLM_CLI_PATH: process.env.OPENAI_CLI_TEST_PATH,
    LLM_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  } });
  assert.equal((await provider.request(request)).message.content, '{"scores":[[70,60]]}');
  assert.equal(calls, 2);
  assert.equal(provider.totalSpend().calls, 1);
});
