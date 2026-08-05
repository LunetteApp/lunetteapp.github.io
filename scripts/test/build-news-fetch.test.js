const assert = require("node:assert/strict");
const test = require("node:test");

const { fetchText } = require("../build-news");

const URL = "https://publisher.example/feed";

test("a valid Chrome response makes exactly one publisher navigation", async () => {
  const engines = [];
  const result = await fetchText(URL, 1000, {
    validate: (text) => text === "valid feed",
    browserFetch: async (_url, { engine }) => {
      engines.push(engine);
      return { engine, text: "valid feed" };
    }
  });

  assert.equal(result, "valid feed");
  assert.deepEqual(engines, ["chrome"]);
});

test("an invalid Chrome response gets one Firefox attempt", async () => {
  const engines = [];
  const result = await fetchText(URL, 1000, {
    validate: (text) => text === "valid feed",
    browserFetch: async (_url, { engine }) => {
      engines.push(engine);
      return {
        engine,
        text: engine === "chrome" ? "challenge page" : "valid feed"
      };
    }
  });

  assert.equal(result, "valid feed");
  assert.deepEqual(engines, ["chrome", "firefox"]);
});

test("two failed browsers stop without a third publisher navigation", async () => {
  const engines = [];

  await assert.rejects(
    fetchText(URL, 1000, {
      validate: () => false,
      browserFetch: async (_url, { engine }) => {
        engines.push(engine);
        throw new Error(`${engine} rejected`);
      }
    }),
    /Chrome and Firefox did not return a valid feed/
  );

  assert.deepEqual(engines, ["chrome", "firefox"]);
});
