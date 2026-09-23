import { test } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_ROWS, queryResultToModelOutput } from "./execute-mongodb";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

test("model sees a preview, not the full result", () => {
  const { value } = queryResultToModelOutput({ output: { rows: rows(300), rowCount: 300 } }) as { value: any };
  assert.equal(value.rowCount, 300);
  assert.equal(value.previewRows.length, PREVIEW_ROWS);
  assert.match(value.note, /250 more rows/);
  assert.equal(value.warning, undefined);
});

test("small results go through whole, capped results warn, errors pass through", () => {
  const small = queryResultToModelOutput({ output: { rows: rows(3), rowCount: 3 } }) as { value: any };
  assert.equal(small.value.previewRows.length, 3);
  assert.equal(small.value.note, undefined);
  const capped = queryResultToModelOutput({ output: { rows: rows(1000), rowCount: 1000, truncated: true } }) as { value: any };
  assert.match(capped.value.warning, /capped/);
  const failed = queryResultToModelOutput({ output: { rows: [], rowCount: 0, error: "boom" } }) as { value: any };
  assert.deepEqual(failed.value, { error: "boom" });
});
