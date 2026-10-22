const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runComparison } = require('../news-test');

function environment(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'news-model-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { output: directory, env: { LLM_API_KEY: 'test-secret', GITHUB_STEP_SUMMARY: path.join(directory, 'step-summary.md') },
    now: new Date('2026-10-22T10:00:00.000Z'), feed: { last_updated: '2026-10-22T09:00:00.000Z', items: [
      { title: 'First-hand watch review', url: 'https://example.test/review', categories: ['Watches'],
        published_at: '2026-10-22T09:00:00.000Z', source_name: 'Watch Journal', lang: 'en', score_quality: 80, score_notif: 50 },
      { title: 'Another independent watch interview', url: 'https://example.test/interview', categories: ['Watches'],
        published_at: '2026-10-22T08:00:00.000Z', source_name: 'Watch Journal', lang: 'en', score_quality: 75, score_notif: 40 },
    ] } };
}

function response(invocation, offset = 2) {
  const request = JSON.parse(invocation.input);
  const length = request.response_format.json_schema.schema.properties.scores.minItems;
  const scores = Array.from({ length }, () => [75, 65]);
  scores[offset + 14][1] = 30; scores[offset + 15][1] = 30;
  const content = { scores, marketing: [3, 5, 6, 7].map(index => index + offset),
    off_topic: [0, 1, 18].map(index => index + offset),
    clusters: [[8, 9, 10], [12, 13], [14, 15]].map(lines => ({ story: 'Known event', lines: lines.map(index => index + offset) })) };
  return { stdout: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } } }) };
}

test('comparison uses identical prompts, the production CLI and fixed per-model prices without changing its feed', async t => {
  const options = environment(t), original = JSON.stringify(options.feed), invocations = [];
  const result = await runComparison({ ...options, runCLIFunction: async invocation => {
    invocations.push(invocation); return response(invocation);
  } });
  assert.equal(invocations.length, 2);
  const bodies = invocations.map(invocation => JSON.parse(invocation.input));
  assert.deepEqual(bodies.map(body => body.model), ['gpt-5.4', 'gpt-5.4-mini']);
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.deepEqual(bodies[0].response_format, bodies[1].response_format);
  assert.ok(bodies.every(body => body.reasoning_effort === 'medium' && body.max_completion_tokens === 32000));
  assert.equal(JSON.stringify(options.feed), original);
  for (const item of result.results) {
    assert.equal(item.ok, true);
    assert.equal(item.raw_score_count, 22);
    assert.equal(item.fixture_checks.marketing_exact, true);
    assert.equal(item.fixture_checks.off_topic_exact, true);
    assert.ok(item.fixture_checks.clusters.every(check => check.passed));
    assert.equal(item.fixture_checks.old_launch_notification_below_35, true);
    assert.ok(fs.existsSync(path.join(options.output, item.model + '.response.json')));
    assert.ok(fs.existsSync(path.join(options.output, item.model + '.analysis.json')));
  }
  assert.equal(result.results[0].standard_price_estimate_usd, 0.01);
  assert.equal(result.results[1].standard_price_estimate_usd, 0.003);
  assert.equal(result.comparison.quality_mean_absolute_difference, 0);
  assert.equal(result.comparison.cluster_pair_agreement, null);
  assert.match(fs.readFileSync(options.env.GITHUB_STEP_SUMMARY, 'utf8'), /similarity, not correctness/);
  for (const file of fs.readdirSync(options.output)) assert.ok(!fs.readFileSync(path.join(options.output, file), 'utf8').includes(options.env.LLM_API_KEY));
});

test('a failed model preserves the other output and a redacted report', async t => {
  const options = environment(t);
  const result = await runComparison({ ...options, runCLIFunction: async invocation => {
    if (JSON.parse(invocation.input).model === 'gpt-5.4-mini') throw new Error('Request rejected: ' + options.env.LLM_API_KEY);
    return response(invocation);
  } });
  assert.equal(result.results[0].ok, true); assert.equal(result.results[1].ok, false);
  assert.equal(result.comparison, null);
  const report = fs.readFileSync(path.join(options.output, 'report.md'), 'utf8');
  assert.match(report, /\[redacted\]/);
  assert.ok(!report.includes(options.env.LLM_API_KEY));
});

test('an output-limit failure does not trigger another model invocation', async t => {
  const options = environment(t), calls = [];
  const result = await runComparison({ ...options, runCLIFunction: async invocation => {
    const model = JSON.parse(invocation.input).model; calls.push(model);
    if (model === 'gpt-5.4') return { stdout: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1000, completion_tokens: 32000 } }) };
    return response(invocation);
  } });
  assert.deepEqual(calls, ['gpt-5.4', 'gpt-5.4-mini']);
  assert.equal(result.results[0].ok, false); assert.equal(result.results[1].ok, true);
  assert.equal(result.results[0].usage.completion_tokens, 32000);
  assert.ok(fs.existsSync(path.join(options.output, 'gpt-5.4.response.json')));
});
