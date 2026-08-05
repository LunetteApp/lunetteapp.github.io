const assert = require("node:assert/strict");
const test = require("node:test");

const { createBrowserFetchManager } = require("../headless-browser-fetch");

const URL = "https://publisher.example/feed";

function fakePage(body) {
  const response = (url) => ({
    ok: () => true,
    request: () => ({ isNavigationRequest: () => true }),
    status: () => 200,
    text: async () => body,
    url: () => url
  });
  return {
    close: async () => {},
    goto: async (url) => response(url),
    mainFrame: () => ({ id: "main" }),
    on: () => {},
    setDefaultNavigationTimeout: () => {},
    setRequestInterception: async () => {},
    waitForResponse: async () => response("https://publisher.example/feed")
  };
}

test("one persistent browser is shared across requests", async () => {
  let launches = 0;
  let pages = 0;
  let closes = 0;
  const manager = createBrowserFetchManager({
    executableFor: () => "/fake/chrome",
    logger: { log() {}, warn() {} },
    puppeteer: {
      launch: async () => {
        launches += 1;
        return {
          close: async () => { closes += 1; },
          newPage: async () => {
            pages += 1;
            return fakePage("feed");
          }
        };
      }
    }
  });

  await manager.fetchText("https://one.example/feed", { engine: "chrome", timeoutMs: 1000 });
  await manager.fetchText("https://two.example/feed", { engine: "chrome", timeoutMs: 1000 });
  await manager.close();

  assert.equal(launches, 1);
  assert.equal(pages, 2);
  assert.equal(closes, 1);
});

test("an unavailable engine is cached and never launched", async () => {
  let executableChecks = 0;
  let launches = 0;
  const manager = createBrowserFetchManager({
    executableFor: () => {
      executableChecks += 1;
      return null;
    },
    logger: { log() {}, warn() {} },
    puppeteer: {
      launch: async () => {
        launches += 1;
      }
    }
  });

  assert.equal(await manager.fetchText(URL, { engine: "firefox", timeoutMs: 1000 }), null);
  assert.equal(await manager.fetchText(URL, { engine: "firefox", timeoutMs: 1000 }), null);

  assert.equal(executableChecks, 1);
  assert.equal(launches, 0);
});

test("Firefox resolves from the response without request interception or DOMContentLoaded", async () => {
  let interceptions = 0;
  let closed = 0;
  const response = {
    ok: () => true,
    request: () => ({ isNavigationRequest: () => true }),
    status: () => 200,
    text: async () => "<rss><channel /></rss>",
    url: () => URL
  };
  const manager = createBrowserFetchManager({
    executableFor: () => "/fake/firefox",
    logger: { log() {}, warn() {} },
    puppeteer: {
      launch: async () => ({
        close: async () => {},
        newPage: async () => ({
          close: async () => { closed += 1; },
          goto: () => new Promise(() => {}),
          setDefaultNavigationTimeout: () => {},
          setRequestInterception: async () => { interceptions += 1; },
          waitForResponse: async () => response
        })
      })
    }
  });

  const result = await manager.fetchText(URL, { engine: "firefox", timeoutMs: 1000 });
  await manager.close();

  assert.equal(result.text, "<rss><channel /></rss>");
  assert.equal(interceptions, 0);
  assert.equal(closed, 1);
});
