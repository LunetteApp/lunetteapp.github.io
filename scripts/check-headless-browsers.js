#!/usr/bin/env node

const assert = require("node:assert/strict");
const http = require("node:http");
const { createBrowserFetchManager } = require("./headless-browser-fetch");

const LOCAL_FEED = "<?xml version=\"1.0\"?><rss><channel><item><title>Browser check</title></item></channel></rss>";

async function main() {
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    response.end(LOCAL_FEED);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const manager = createBrowserFetchManager({ maxPages: 1 });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/feed`;

  try {
    for (const engine of ["chrome", "firefox"]) {
      const result = await manager.fetchText(url, { engine, timeoutMs: 15_000 });
      assert.ok(result, `${engine} could not be launched`);
      assert.match(result.text, /<rss\b/i, `${engine} did not return the local RSS body`);
      console.log(`[browser-check] ${engine} ok`);
    }
  } finally {
    await manager.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
