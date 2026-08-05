// USD per million tokens, from the OpenAI flagship price list. Only the
// short-context tier is listed: these prompts run around 5k tokens, so the
// long-context rates never apply. A null cached rate means the model has no
// cache discount and cached tokens bill at the full input rate.
const PRICES = {
  "gpt-5.6-sol": { input: 5.00, cachedInput: 0.50, output: 30.00 },
  "gpt-5.6-terra": { input: 2.00, cachedInput: 0.20, output: 12.00 },
  "gpt-5.6-luna": { input: 0.20, cachedInput: 0.02, output: 1.20 },
  "gpt-5.5": { input: 5.00, cachedInput: 0.50, output: 30.00 },
  "gpt-5.5-pro": { input: 30.00, cachedInput: null, output: 180.00 },
  "gpt-5.4": { input: 2.50, cachedInput: 0.25, output: 15.00 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.50 },
  "gpt-5.4-nano": { input: 0.20, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30.00, cachedInput: null, output: 180.00 }
};

// Dated snapshots such as gpt-5.4-mini-2026-01-01 bill at their base model's
// rate, so the longest matching prefix wins.
function priceForModel(model) {
  const name = String(model || "").trim();
  if (PRICES[name]) return PRICES[name];
  const prefix = Object.keys(PRICES)
    .filter((known) => name.startsWith(`${known}-`))
    .sort((left, right) => right.length - left.length)[0];
  return prefix ? PRICES[prefix] : null;
}

module.exports = {
  PRICES,
  priceForModel
};
