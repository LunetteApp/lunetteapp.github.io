const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const BASE_CURRENCY = "EUR";
const SOURCE_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const SOURCE_PAGE =
  "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";
const TERMS_URL =
  "https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html";
const OUTPUT_PATH = path.join(__dirname, "..", "api", "v1", "exchange-rates.json");
const MINIMUM_RATE_COUNT = 25;
const REQUIRED_CURRENCIES = ["USD", "JPY", "GBP", "CHF", "CNY"];
const MAX_ATTEMPTS = 4;

function parseSourceRates(xml) {
  if (typeof xml !== "string" || !xml.includes("European Central Bank")) {
    throw new Error("The response is not an ECB exchange-rate feed");
  }

  const dateMatch = xml.match(/<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']/);
  if (!dateMatch) {
    throw new Error("The ECB feed does not contain a publication date");
  }

  const date = dateMatch[1];
  const rows = [];
  const cubePattern = /<Cube\b([^>]*)\/>/g;

  for (const match of xml.matchAll(cubePattern)) {
    const attributes = match[1];
    const currencyMatch = attributes.match(/\bcurrency=["']([A-Z]{3})["']/);
    const rateMatch = attributes.match(/\brate=["']([0-9]+(?:\.[0-9]+)?)["']/);

    if (currencyMatch && rateMatch) {
      rows.push({
        currency: currencyMatch[1],
        date,
        rate: Number(rateMatch[1]),
      });
    }
  }

  return rows;
}

function validateSourceRates(rows) {
  if (!Array.isArray(rows) || rows.length < MINIMUM_RATE_COUNT) {
    throw new Error(
      `Expected at least ${MINIMUM_RATE_COUNT} ECB exchange rates, received ${
        Array.isArray(rows) ? rows.length : "a non-array response"
      }`,
    );
  }

  const currencies = new Set();

  for (const row of rows) {
    if (
      !row ||
      !/^[A-Z]{3}$/.test(row.currency) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(row.rate) ||
      row.rate <= 0
    ) {
      throw new Error(`Invalid ECB exchange-rate row: ${JSON.stringify(row)}`);
    }

    if (currencies.has(row.currency)) {
      throw new Error(`Duplicate ECB exchange rate for ${row.currency}`);
    }

    currencies.add(row.currency);
  }

  for (const currency of REQUIRED_CURRENCIES) {
    if (!currencies.has(currency)) {
      throw new Error(`ECB response is missing the required ${currency} rate`);
    }
  }
}

function buildDocument(rows) {
  const date = rows[0].date;
  const rates = {
    EUR: {
      rate: 1,
    },
  };

  for (const row of [...rows].sort((left, right) => left.currency.localeCompare(right.currency))) {
    rates[row.currency] = {
      rate: row.rate,
    };
  }

  return {
    base: BASE_CURRENCY,
    date,
    source: {
      name: "European Central Bank",
      url: SOURCE_PAGE,
      attribution: "Source: European Central Bank (ECB).",
      terms: TERMS_URL,
      transformation: "Converted from the ECB XML feed to JSON; published rate values are unchanged.",
    },
    rates,
  };
}

function validateDocument(document) {
  if (
    !document ||
    document.base !== BASE_CURRENCY ||
    !/^\d{4}-\d{2}-\d{2}$/.test(document.date) ||
    document.source?.name !== "European Central Bank" ||
    document.source?.url !== SOURCE_PAGE ||
    document.source?.attribution !== "Source: European Central Bank (ECB)." ||
    document.source?.terms !== TERMS_URL ||
    !document.rates ||
    Array.isArray(document.rates) ||
    typeof document.rates !== "object"
  ) {
    throw new Error("Invalid exchange-rates document metadata");
  }

  const entries = Object.entries(document.rates);
  if (entries.length < MINIMUM_RATE_COUNT + 1) {
    throw new Error(`Expected at least ${MINIMUM_RATE_COUNT + 1} saved exchange rates`);
  }

  for (const [currency, value] of entries) {
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !value ||
      !Number.isFinite(value.rate) ||
      value.rate <= 0
    ) {
      throw new Error(`Invalid saved exchange rate for ${currency}`);
    }
  }

  if (document.rates.EUR?.rate !== 1) {
    throw new Error("The EUR base rate must be 1");
  }
}

async function fetchRates() {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(SOURCE_URL, {
        headers: {
          Accept: "application/xml, text/xml",
          "User-Agent": "Lunette-exchange-rates/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`ECB returned HTTP ${response.status}`);
      }

      const rows = parseSourceRates(await response.text());
      validateSourceRates(rows);
      return rows;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_ATTEMPTS) {
        const delayMs = attempt * 5_000;
        console.warn(`Fetch attempt ${attempt} failed: ${error.message}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

async function main() {
  if (process.argv.includes("--validate")) {
    const document = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
    validateDocument(document);
    console.log(`Validated ${Object.keys(document.rates).length} exchange rates.`);
    return;
  }

  const rows = await fetchRates();
  const document = buildDocument(rows);
  validateDocument(document);

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Saved ${rows.length + 1} exchange rates to ${OUTPUT_PATH}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
