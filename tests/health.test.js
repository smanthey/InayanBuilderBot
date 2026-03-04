import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";

test("GET /health returns ok", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.service, "string");

  server.close();
});
