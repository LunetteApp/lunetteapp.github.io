const fs = require("fs");
const puppeteer = require("puppeteer-core");

const DEFAULT_MAX_PAGES = 3;

const EXECUTABLE_CANDIDATES = {
  chrome: [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ],
  firefox: [
    process.env.FIREFOX_BIN,
    "/usr/bin/firefox",
    "/usr/bin/firefox-esr",
    "/Applications/Firefox.app/Contents/MacOS/firefox"
  ]
};

function firstExecutable(engine) {
  for (const candidate of EXECUTABLE_CANDIDATES[engine] || []) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
  return null;
}

function createLimiter(maxConcurrent) {
  let active = 0;
  const waiting = [];

  return async function limited(operation) {
    if (active >= maxConcurrent) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;

    try {
      return await operation();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function createBrowserFetchManager(options = {}) {
  const browserDriver = options.puppeteer ?? puppeteer;
  const executableFor = options.executableFor ?? firstExecutable;
  const logger = options.logger ?? console;
  const maxPages = Math.max(1, Number(options.maxPages ?? process.env.NEWS_BROWSER_MAX_PAGES ?? DEFAULT_MAX_PAGES));
  const browsers = new Map();
  const limiters = new Map([
    ["chrome", createLimiter(maxPages)],
    ["firefox", createLimiter(maxPages)]
  ]);

  async function launch(engine) {
    const executablePath = executableFor(engine);
    if (!executablePath) {
      logger.warn(`[browser] ${engine} executable is unavailable`);
      return null;
    }

    try {
      const launchOptions = {
        browser: engine,
        executablePath,
        headless: true,
        protocolTimeout: 30_000,
        args: engine === "chrome"
          ? [
              "--no-sandbox",
              "--disable-dev-shm-usage",
              "--disable-background-networking",
              "--disable-default-apps",
              "--disable-extensions",
              "--disable-sync",
              "--metrics-recording-only",
              "--mute-audio",
              "--no-first-run",
              "--lang=en-US"
            ]
          : [],
        extraPrefsFirefox: engine === "firefox"
          ? {
              "browser.chrome.favicons": false,
              "browser.chrome.site_icons": false,
              "intl.accept_languages": "en-US, en",
              "javascript.enabled": false,
              "network.dns.disablePrefetch": true,
              "network.http.speculative-parallel-limit": 0,
              "network.prefetch-next": false,
              "permissions.default.image": 2,
              "permissions.default.stylesheet": 2
            }
          : undefined
      };
      const browser = await browserDriver.launch(launchOptions);
      logger.log(`[browser] started ${engine} from ${executablePath}; max pages=${maxPages}`);
      return browser;
    } catch (error) {
      logger.warn(`[browser] could not start ${engine}: ${error?.message ?? error}`);
      return null;
    }
  }

  function browserFor(engine) {
    if (!browsers.has(engine)) {
      // Cache the startup attempt as well as successful browsers. A missing or
      // broken executable must not be launched again for every feed.
      browsers.set(engine, launch(engine));
    }
    return browsers.get(engine);
  }

  async function fetchText(url, { engine, timeoutMs }) {
    if (!limiters.has(engine)) throw new Error(`Unsupported browser engine: ${engine}`);

    return limiters.get(engine)(async () => {
      const browser = await browserFor(engine);
      if (!browser) return null;

      const page = await browser.newPage();
      try {
        page.setDefaultNavigationTimeout(timeoutMs);

        if (engine === "chrome") {
          await page.setRequestInterception(true);
          page.on("request", (request) => {
            const isMainNavigation = request.isNavigationRequest()
              && request.frame() === page.mainFrame();
            const action = isMainNavigation ? request.continue() : request.abort();
            action.catch(() => {});
          });
        }

        // Firefox's WebDriver BiDi interception can stall XML navigations. Its
        // launch preferences disable active/subresource content instead, while
        // Chrome strictly aborts every request except the main navigation and
        // redirects. Resolve on the final response rather than DOMContentLoaded:
        // Firefox does not consistently emit that lifecycle event for raw XML.
        const finalResponse = page.waitForResponse((candidate) => {
          const status = candidate.status();
          return candidate.request().isNavigationRequest()
            && (status < 300 || status >= 400);
        }, { timeout: timeoutMs });
        const navigation = page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs
        });
        const response = await Promise.race([finalResponse, navigation]);
        if (!response) throw new Error(`No navigation response for ${url}`);

        const text = await response.text();
        if (!response.ok()) {
          const preview = text.trim().slice(0, 120).replace(/\s+/g, " ");
          throw new Error(`HTTP ${response.status()} for ${url} — ${preview}`);
        }

        return {
          engine,
          finalURL: response.url(),
          text
        };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async function close() {
    const pending = [...browsers.values()];
    browsers.clear();
    const opened = await Promise.all(pending);
    await Promise.all(opened.filter(Boolean).map((browser) => browser.close().catch(() => {})));
  }

  return { close, fetchText };
}

const defaultManager = createBrowserFetchManager();

module.exports = {
  closeHeadlessBrowsers: defaultManager.close,
  createBrowserFetchManager,
  fetchTextWithBrowser: defaultManager.fetchText,
  firstExecutable
};
