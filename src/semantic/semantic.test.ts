import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

const dir = path.join(import.meta.dirname);
const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".yml"));

// The agent reads these as text, but broken YAML usually means a value got cut at an unquoted ": "
test("every semantic file is valid YAML", () => {
  for (const f of files) assert.doesNotThrow(() => load(readFileSync(path.join(dir, f), "utf8")), f);
});
