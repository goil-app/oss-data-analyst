import { test } from "node:test";
import assert from "node:assert/strict";
import { liveProgress } from "./progress";

test("coalesces bursts into few edits, always ending on the latest text", async () => {
  const edits: string[] = [];
  const p = liveProgress(async (t) => void edits.push(t), 20);
  p.add("a");
  p.add("b");
  p.add("b"); // repeated step ignored
  p.add("c");
  await p.done();
  assert.deepEqual(edits, ["a", "a\nb\nc"]);
});
