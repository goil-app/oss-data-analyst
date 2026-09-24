import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl } from "./execute-langfuse";

test("traces never request input/output and cap the page size", () => {
  const url = new URL(buildUrl("traces", { fields: "core,io", limit: 500, tags: ["a", "b"] }));
  assert.equal(url.pathname, "/api/public/traces");
  assert.equal(url.searchParams.get("fields"), "core,scores,metrics");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.deepEqual(url.searchParams.getAll("tags"), ["a", "b"]);
});

test("metrics sends the query object as JSON", () => {
  const q = { view: "observations", metrics: [{ measure: "count", aggregation: "count" }] };
  const url = new URL(buildUrl("metrics", q));
  assert.equal(url.pathname, "/api/public/v2/metrics");
  assert.deepEqual(JSON.parse(url.searchParams.get("query")!), q);
});
