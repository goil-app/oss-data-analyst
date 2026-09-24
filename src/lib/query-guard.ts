/**
 * Defense-in-depth for agent-built MongoDB queries. The real guarantees are a
 * read-only MongoDB user (checked in mongodb.ts) and PII never leaving the host;
 * this module rejects queries that could write, run server-side JS, or touch PII.
 */

const DEFAULT_PII_FIELDS = [
  "phone", "username", "latitude", "longitude", "uniqueAuthCode", "walletNumber", "street", "attributesValue",
  // secrets (SettingsDB.Settings: SMTP, WhatsApp, API keys; OnboardingSession)
  "password", "accessToken", "apiKey", "apiKeys", "publishableKey", "secretKey", "keys", "pwdHash", "generatedPassword", "tokens",
];

export const PII_FIELDS = new Set([
  ...DEFAULT_PII_FIELDS,
  ...(process.env.PII_FIELDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

const FORBIDDEN_OPERATORS = new Set([
  // writes
  "$out", "$merge",
  // server-side JavaScript
  "$where", "$function", "$accumulator",
  // introspection
  "$currentOp", "$listSessions", "$listLocalSessions", "$collStats", "$indexStats", "$planCacheStats",
  // dynamic field access (would bypass the field-name checks below)
  "$objectToArray", "$getField", "$setField",
]);

// Stage/operator keys whose string value names another collection.
const COLLECTION_KEYS = new Set(["from", "coll"]);

export class QueryRejected extends Error {}

/** Field path segments of a key ("a.phone") or field ref ("$a.phone", "$$ROOT.phone"). */
const segments = (s: string) => s.replace(/^\$+/, "").split(".");

const touchesPii = (s: string) => segments(s).some((seg) => PII_FIELDS.has(seg));

/**
 * Throws QueryRejected if the query uses a forbidden operator, references a PII
 * field anywhere (key, field ref or plain string), or reads a collection outside
 * `allowedCollections`.
 */
export function assertSafeQuery(query: unknown, allowedCollections: Set<string>): void {
  const walk = (value: unknown, parentKey?: string): void => {
    if (typeof value === "string") {
      if (touchesPii(value)) throw new QueryRejected(`Reference to personal data field is not allowed: "${value}"`);
      if (parentKey && (COLLECTION_KEYS.has(parentKey) || parentKey === "$unionWith") && !allowedCollections.has(value)) {
        throw new QueryRejected(`Collection "${value}" is not allowed`);
      }
      return;
    }
    if (Array.isArray(value)) return value.forEach((v) => walk(v, parentKey));
    if (value !== null && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (FORBIDDEN_OPERATORS.has(key)) throw new QueryRejected(`Operator "${key}" is not allowed`);
        if (touchesPii(key)) throw new QueryRejected(`Reference to personal data field is not allowed: "${key}"`);
        walk(v, key);
      }
    }
  };
  walk(query);
}

/** Replaces the value of any PII-named key, at any depth, with "***". */
export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPii);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, PII_FIELDS.has(k) ? "***" : redactPii(v)])
    );
  }
  return value;
}
