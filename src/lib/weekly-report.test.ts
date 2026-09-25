import { test } from "node:test";
import assert from "node:assert/strict";
import { reportWeeks } from "./weekly-report";

test("reports the previous Monday-to-Sunday week, whatever day it runs", () => {
  const week = { from: "2026-09-14", to: "2026-09-21", prevFrom: "2026-09-07", lastDay: "2026-09-20" };
  assert.deepEqual(reportWeeks(new Date("2026-09-21T07:00:00Z")), week); // Monday (cron)
  assert.deepEqual(reportWeeks(new Date("2026-09-24T19:00:00Z")), week); // Thursday (manual run)
  assert.deepEqual(reportWeeks(new Date("2026-09-27T23:00:00Z")), week); // Sunday
});
