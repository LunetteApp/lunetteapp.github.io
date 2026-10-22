const fs = require('node:fs');
const path = require('node:path');
const { analyseArticles, normalizeAnalysis, validateAnalysis } = require('./analyze-news');
const { compactArticleID } = require('./news-utils');
const { priceForModel } = require('./llm-prices');
const { createLLMProvider, runOpenAICLI } = require('./llm-provider');

async function runComparison({ env = process.env, runCLIFunction = runOpenAICLI,
  feed = JSON.parse(fs.readFileSync(path.join(__dirname, '../api/v1/news.json'), 'utf8')),
  output = env.NEWS_TEST_OUTPUT_DIR, now = new Date(), models = ['gpt-5.4'] } = {}) {
  const key = env.LLM_API_KEY || env.OPENAI_API_KEY;
  if (!key) throw new Error('The existing news-job API secret is unavailable.');
  if (!output) throw new Error('Set NEWS_TEST_OUTPUT_DIR to a separate evaluation output directory.');
  fs.mkdirSync(output, { recursive: true });
  const live = feed.items.slice(0, 100).map(article => ({ ...article, score_quality: -1, score_notif: -1 }));
  const fixture = (title, preview, categories = ['Watches'], lang = 'en', ageHours = 1) => ({
    title, peek_preview: preview, categories, lang, source_name: 'Controlled evaluation fixture',
    published_at: new Date(now - ageHours * 3600000).toISOString(), score_quality: -1, score_notif: -1,
  });
  const fixtures = [
    fixture('Suzuki e-Vitara Review: Electric SUV Lifestyle Test with Video', 'Road testing an electric SUV, its charging range and cabin.', ['Cars', 'Automotive']),
    fixture('Una settimana in un resort sul lago: guida alle vacanze', 'Camere, ristoranti e attività per una vacanza sul lago.', ['Travel'], 'it'),
    fixture('Hands-On: Porsche Design Chronograph 1', 'Independent wrist review of the titanium automatic chronograph and its movement.'),
    fixture('Arcadian Meridian M1 now live on Kickstarter: early-bird pledges open', 'Back our watch campaign today and reserve your early-bird discount.'),
    fixture('Investigation: Where did the money from a failed watch crowdfunding campaign go?', 'An independent investigation interviews backers and examines the failed campaign.'),
    fixture('Partner content: Introducing the Arcadian Dive 300', 'Paid partnership with the brand presenting its latest dive watch.', ['Sponsored content']),
    fixture('Win a luxury watch: enter our reader giveaway', 'Enter the competition for a chance to win a watch.'),
    fixture('The best watch deals this week: save 30% with our affiliate links', 'Shopping offers and discount codes. We earn commission on purchases.'),
    fixture('Introducing: Ming 37.06 Royal Selangor Limited Edition', 'A new Ming collaboration with Royal Selangor featuring a hammered pewter dial.'),
    fixture('Ming stellt die 37.06 Royal Selangor mit gehämmertem Zifferblatt vor', 'Neue limitierte Zusammenarbeit von Ming und Royal Selangor mit einem Zifferblatt aus Zinn.', ['Watches'], 'de'),
    fixture('Ming dévoile la 37.06 Royal Selangor et son cadran en étain martelé', 'La nouvelle édition limitée née de la collaboration entre Ming et Royal Selangor.', ['Watches'], 'fr'),
    fixture('Hands-On: Ming 37.09 Bluefin', 'Independent review of the Ming 37.09 Bluefin dive watch. This is not the 37.06 Royal Selangor.'),
    fixture('H. Moser & Cie. Streamliner Perpetual Calendar Concept', 'Moser removes dial markers from its Streamliner perpetual calendar, creating a new Concept version.'),
    fixture("Moser takes every marker off its Streamliner QP", 'The latest Concept model gives the perpetual calendar a minimalist dial without indices.'),
    fixture('Introducing: Arcadian Meridian M1 Titanium', 'The brand announces a new titanium Meridian M1 watch.', ['Watches'], 'en', 96),
    fixture('A closer look at the Arcadian Meridian M1 Titanium announced this week', 'A recap of the same titanium Meridian M1 launch first announced four days ago.'),
    fixture('Interview: How an independent watchmaker finishes a movement by hand', 'A first-hand interview about traditional hand finishing and the watchmaker’s career.'),
    fixture('Why vintage sector dials still fascinate collectors', 'An illustrated historical explanation of sector dials. No new product is announced.'),
    fixture('New laptop review: battery life, keyboard and display', 'A review of a general-purpose laptop, with no connection to watches.', ['Technology']),
    fixture('Hands-On: TAG Heuer Monaco Chronograph Racing Edition', 'Independent watch review covering the case, automatic movement and racing-inspired dial.'),
  ].map((article, index) => ({ ...article, url: 'https://evaluation.invalid/case-' + index }));
  const articles = [...live, ...fixtures];
  const ids = articles.map(article => compactArticleID(article.url));
  const fixtureOffset = live.length;
  const expected = { marketing: [3, 5, 6, 7], off_topic: [0, 1, 18], clusters: [[8, 9, 10], [12, 13], [14, 15]], old_launch: [14, 15] };
  let captured;
  try { await analyseArticles(articles, 'gpt-5.4', async request => { captured = request; throw new Error('capture_only'); }, { forceRescoring: true }); }
  catch (error) { if (!captured) throw error; }
  const input = { generated_at: now.toISOString(), feed_updated_at: feed.last_updated, real_articles: live.length,
    fixture_offset: fixtureOffset, fixture_count: fixtures.length, expected, articles, messages: captured.messages };
  fs.writeFileSync(path.join(output, 'input.json'), JSON.stringify(input, null, 2));
  const results = await Promise.all(models.map(async model => {
    const started = Date.now();
    let payload, calls = 0;
    const provider = createLLMProvider({
      env: { ...env, LLM_API_KEY: key, LLM_MODEL: model, LLM_REASONING_EFFORT: 'medium',
        LLM_PRICE_INPUT: '', LLM_PRICE_CACHED_INPUT: '', LLM_PRICE_OUTPUT: '' },
      logger: (stage, message) => console.log(model + ': ' + message),
      runCLIFunction: async invocation => {
        if (calls++) throw new Error('The comparison allows one model invocation per model.');
        const response = await runCLIFunction(invocation);
        payload = JSON.parse(response.stdout);
        fs.writeFileSync(path.join(output, model + '.response.json'), JSON.stringify(payload, null, 2));
        return response;
      },
      sleepFunction: async () => {},
    });
    console.log(model + ': one request started');
    try {
      await provider.request({ ...captured, model });
      const choice = payload.choices?.[0], content = choice?.message?.content;
      const prices = priceForModel(model), usage = payload.usage;
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const estimatedCost = prices && usage ? ((usage.prompt_tokens - cached) * prices.input + cached * prices.cachedInput + usage.completion_tokens * prices.output) / 1e6 : null;
      const result = { model, ok: false, seconds: (Date.now() - started) / 1000, finish_reason: choice?.finish_reason,
        usage, standard_price_estimate_usd: estimatedCost, actual_billed_cost: 'Not supplied by the completion response; free-sharing treatment is account-dependent.' };
      try {
        const raw = JSON.parse(content);
        const analysis = normalizeAnalysis(raw, ids, articles, ids.map((_, index) => index));
        validateAnalysis(analysis, ids);
        fs.writeFileSync(path.join(output, model + '.analysis.json'), JSON.stringify(analysis, null, 2));
        const fixtureIndex = id => ids.indexOf(id) - fixtureOffset;
        const found = values => values.map(fixtureIndex).filter(index => index >= 0).sort((a, b) => a - b);
        const idGroup = id => analysis.clusters.find(group => group.articleIDs.includes(id));
        const rawFixtures = key => (raw[key] ?? []).filter(index => index >= fixtureOffset).map(index => index - fixtureOffset).sort((a, b) => a - b);
        result.raw_fixture_marketing = rawFixtures('marketing'); result.raw_fixture_off_topic = rawFixtures('off_topic');
        result.fixture_marketing = found(analysis.marketing); result.fixture_off_topic = found(analysis.off_topic);
        result.fixture_clusters = analysis.clusters.map(group => found(group.articleIDs)).filter(group => group.length >= 2);
        result.fixture_checks = {
          marketing_exact: JSON.stringify(result.fixture_marketing) === JSON.stringify(expected.marketing),
          off_topic_exact: JSON.stringify(result.fixture_off_topic) === JSON.stringify(expected.off_topic),
          clusters: expected.clusters.map(indices => {
            const group = idGroup(ids[fixtureOffset + indices[0]]);
            return { cases: indices, passed: !!group && indices.every(index => group.articleIDs.includes(ids[fixtureOffset + index])) &&
              found(group.articleIDs).length === indices.length };
          }),
          different_reference_kept_separate: !idGroup(ids[fixtureOffset + 8])?.articleIDs.includes(ids[fixtureOffset + 11]),
          old_launch_notification_below_35: expected.old_launch.every(index => analysis.scores[ids[fixtureOffset + index]].notification < 35),
        };
        result.real_marketing = analysis.marketing.filter(id => ids.indexOf(id) < fixtureOffset).map(id => ids.indexOf(id));
        result.real_off_topic = analysis.off_topic.filter(id => ids.indexOf(id) < fixtureOffset).map(id => ids.indexOf(id));
        result.real_clusters = analysis.clusters.map(group => group.articleIDs.map(id => ids.indexOf(id)).filter(index => index < fixtureOffset)).filter(group => group.length >= 2);
        result.real_scores = ids.slice(0, fixtureOffset).map((id, index) => ({ index, ...analysis.scores[id] }));
        result.raw_score_count = raw.scores?.length; result.ok = true;
      } catch (error) { result.validation_error = error.message; }
      console.log(model + ': completed, valid=' + result.ok + ', seconds=' + result.seconds);
      return result;
    } catch (error) { return { model, ok: false, seconds: (Date.now() - started) / 1000,
      error: String(error.message).split(key).join('[redacted]'),
      usage: payload?.usage ?? null, standard_price_estimate_usd: payload?.usage ? provider.totalSpend().cost : null }; }
  }));
  const summary = { generated_at: now.toISOString(), real_articles: live.length, fixture_count: fixtures.length, expected, results,
    comparison: compareResults(results) };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  const report = renderReport(summary, articles);
  fs.writeFileSync(path.join(output, 'report.md'), report);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report);
  return summary;
}

function compareResults(results) {
  if (results.length !== 2 || results.some(result => !result.ok)) return null;
  const [full, mini] = results;
  const disagreement = key => [...new Set([...full[key], ...mini[key]])].filter(index => full[key].includes(index) !== mini[key].includes(index));
  const pairs = clusters => new Set(clusters.flatMap(group => group.flatMap((a, i) => group.slice(i + 1).map(b => [a, b].sort((x, y) => x - y).join(':')))));
  const a = pairs(full.real_clusters), b = pairs(mini.real_clusters);
  const intersection = [...a].filter(pair => b.has(pair));
  const union = new Set([...a, ...b]);
  const mean = key => full.real_scores.length ? full.real_scores.reduce((sum, score, index) => sum + Math.abs(score[key] - mini.real_scores[index][key]), 0) / full.real_scores.length : null;
  return { quality_mean_absolute_difference: mean('quality'), notification_mean_absolute_difference: mean('notification'),
    cluster_pair_agreement: union.size ? intersection.length / union.size : null,
    marketing_disagreements: disagreement('real_marketing'), off_topic_disagreements: disagreement('real_off_topic') };
}

function renderReport(summary, articles) {
  const text = value => String(value).replaceAll('|', '/').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]/g, ' ');
  const lines = ['# News evaluation', '',
    summary.real_articles + ' current articles and ' + summary.fixture_count + ' controlled edge cases. The selected models use the production prompt with medium reasoning and a 32,000-token output limit.', '',
    'One model invocation per model. No feed is published. Prices below are standard-rate estimates, not confirmed charges after free-sharing allowances.', '',
    '| Model | Valid output | Seconds | Input tokens | Output tokens | Estimated USD |',
    '| --- | --- | ---: | ---: | ---: | ---: |'];
  for (const result of summary.results) lines.push('| ' + result.model + ' | ' + result.ok + ' | ' + result.seconds.toFixed(1) + ' | ' + (result.usage?.prompt_tokens ?? 'unknown') + ' | ' + (result.usage?.completion_tokens ?? 'unknown') + ' | ' + (result.standard_price_estimate_usd?.toFixed(5) ?? 'unknown') + ' |');
  lines.push('', '## Controlled cases', '', 'Expected filters and clusters are recorded in input.json. These checks have labeled expectations. Agreement on the live articles measures similarity, not correctness.');
  for (const result of summary.results) {
    lines.push('', '### ' + result.model);
    if (!result.ok) { lines.push('', 'Failed: ' + text(result.error ?? result.validation_error ?? result.finish_reason)); continue; }
    lines.push('', '- Raw model advertising cases: ' + JSON.stringify(result.raw_fixture_marketing),
      '- Raw model off-topic cases: ' + JSON.stringify(result.raw_fixture_off_topic),
      '- Advertising after production rules: ' + result.fixture_checks.marketing_exact,
      '- Off-topic classification: ' + result.fixture_checks.off_topic_exact,
      '- Expected clusters: ' + result.fixture_checks.clusters.map(check => JSON.stringify(check.cases) + ': ' + check.passed).join(', '),
      '- Different watch references kept separate: ' + result.fixture_checks.different_reference_kept_separate,
      '- Old launch notification below 35: ' + result.fixture_checks.old_launch_notification_below_35);
  }
  if (summary.comparison) {
    const comparison = summary.comparison;
    lines.push('', '## Live article differences', '',
      '- Mean quality-score difference: ' + (comparison.quality_mean_absolute_difference?.toFixed(2) ?? 'n.a.'),
      '- Mean notification-score difference: ' + (comparison.notification_mean_absolute_difference?.toFixed(2) ?? 'n.a.'),
      '- Cluster pair agreement: ' + (comparison.cluster_pair_agreement === null ? 'No duplicate pairs to compare' : (comparison.cluster_pair_agreement * 100).toFixed(1) + '%'));
    for (const [title, indices] of [['Advertising disagreements', comparison.marketing_disagreements], ['Off-topic disagreements', comparison.off_topic_disagreements]]) {
      lines.push('', '### ' + title);
      lines.push(...(indices.length ? indices.map(index => '- [' + index + '] ' + text(articles[index].title)) : ['None.']));
    }
  }
  for (const result of summary.results.filter(result => result.ok)) {
    lines.push('', '### ' + result.model + ' live clusters');
    for (const group of result.real_clusters) lines.push('- ' + group.map(index => '[' + index + '] ' + text(articles[index].title)).join(' / '));
    if (!result.real_clusters.length) lines.push('No multi-article clusters.');
    lines.push('', '### ' + result.model + ' highest notification priorities', '',
      '| Article | Notification | Quality |', '| --- | ---: | ---: |');
    const ranked = result.real_scores.filter(score => !result.real_marketing.includes(score.index) && !result.real_off_topic.includes(score.index))
      .toSorted((a, b) => b.notification - a.notification || b.quality - a.quality).slice(0, 10);
    for (const score of ranked) lines.push('| [' + score.index + '] ' + text(articles[score.index].title) + ' | ' + score.notification + ' | ' + score.quality + ' |');
  }
  lines.push('', 'Download the news-test artifact for the frozen input, raw API responses, normalized analyses and summary.json.', '');
  return lines.join('\n');
}

if (require.main === module) {
  runComparison().then(summary => { if (summary.results.some(result => !result.ok)) process.exitCode = 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runComparison, compareResults, renderReport };
