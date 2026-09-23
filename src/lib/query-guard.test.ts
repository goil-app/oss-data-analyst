import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeQuery, redactPii } from "./query-guard";

const allowed = new Set(["Account", "AccountType"]);
const ok = (q: unknown) => assert.doesNotThrow(() => assertSafeQuery(q, allowed));
const rejected = (q: unknown) => assert.throws(() => assertSafeQuery(q, allowed));

test("allows normal analytics queries", () => {
  ok({ blocked: false, creationDate: { $gte: "2026-01-01" } });
  ok([
    { $match: { validated: true } },
    { $lookup: { from: "AccountType", localField: "accountType", foreignField: "_id", as: "type" } },
    { $group: { _id: "$type.name", count: { $sum: 1 } } },
  ]);
});

test("rejects writes and server-side JS", () => {
  rejected([{ $out: "stolen" }]);
  rejected([{ $merge: { into: "x" } }]);
  rejected({ $where: "this.a == 1" });
  rejected([{ $group: { _id: null, x: { $accumulator: {} } } }]);
  rejected({ $expr: { $function: { body: "", args: [], lang: "js" } } });
});

test("rejects PII by key, field ref, alias and dynamic access", () => {
  rejected({ phone: { $regex: "^6" } });
  rejected([{ $group: { _id: "$location.street" } }]);
  rejected([{ $project: { x: "$phone" } }]);
  rejected([{ $project: { x: { $concat: ["$profile.username", ""] } } }]);
  rejected([{ $group: { _id: "$$ROOT.latitude" } }]);
  rejected([{ $project: { kv: { $objectToArray: "$$ROOT" } } }]);
  rejected([{ $project: { x: { $getField: "phone" } } }]);
  rejected([{ $lookup: { from: "Account", localField: "phone", foreignField: "phone", as: "a" } }]);
});

test("rejects collections outside the allowlist", () => {
  rejected([{ $lookup: { from: "Secrets", localField: "a", foreignField: "b", as: "c" } }]);
  rejected([{ $unionWith: "Secrets" }]);
  rejected([{ $unionWith: { coll: "Secrets" } }]);
});

test("redacts PII keys at any depth", () => {
  assert.deepEqual(redactPii([{ a: 1, phone: "600", nested: [{ username: "x" }] }]), [
    { a: 1, phone: "***", nested: [{ username: "***" }] },
  ]);
});
