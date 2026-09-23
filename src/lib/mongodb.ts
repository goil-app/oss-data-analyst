import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { EJSON } from "bson";
import { MongoClient, ObjectId, type Document } from "mongodb";
import { assertSafeQuery, PII_FIELDS, QueryRejected } from "./query-guard";

export const SEMANTIC_DIR = path.join(process.cwd(), "src/semantic");

/** databases.yml is the allowlist: only these databases and collections can be queried. */
export const DATABASES = new Map(
  (load(readFileSync(path.join(SEMANTIC_DIR, "databases.yml"), "utf8")) as {
    databases: { name: string; collections: string[] }[];
  }).databases.map((d) => [d.name, new Set(d.collections)])
);

const MAX_TIME_MS = 30_000;
const MAX_ROWS = 1000;
const WRITE_ACTIONS = new Set([
  "insert", "update", "remove", "createCollection", "dropCollection", "dropDatabase",
  "createIndex", "dropIndex", "renameCollectionSameDB", "collMod", "bypassDocumentValidation",
]);

let clientPromise: Promise<MongoClient> | null = null;

/** Refuses (in production) to run with a MongoDB user that can write. */
async function assertReadOnlyUser(client: MongoClient) {
  const { authInfo } = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
  const writes = new Set<string>(
    authInfo.authenticatedUserPrivileges.flatMap((p: { actions: string[] }) => p.actions).filter((a: string) => WRITE_ACTIONS.has(a))
  );
  const problem = authInfo.authenticatedUsers.length === 0
    ? "MongoDB connection is unauthenticated"
    : writes.size > 0 && `MongoDB user has write privileges (${[...writes].join(", ")})`;
  if (!problem) return;
  if (process.env.NODE_ENV === "production") throw new Error(`${problem}. Use a read-only user.`);
  console.warn(`[MongoDB] WARNING: ${problem}. Production requires a read-only user.`);
}

function getClient(): Promise<MongoClient> {
  clientPromise ??= MongoClient.connect(process.env.MONGODB_URI!, {
    maxPoolSize: 5,
    readPreference: "secondaryPreferred",
  })
    .then(async (client) => {
      await assertReadOnlyUser(client);
      return client;
    })
    .catch((err) => {
      clientPromise = null;
      throw err;
    });
  return clientPromise;
}

/** Parses Extended JSON ({"$date": ...}, {"$oid": ...}) and converts 24-hex strings to ObjectId so agent filters match stored types. */
function deserialize(value: unknown): unknown {
  return deserializeObjectIds(EJSON.deserialize(value as Document));
}

function deserializeObjectIds(value: unknown): unknown {
  if (typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)) return new ObjectId(value);
  if (Array.isArray(value)) return value.map(deserializeObjectIds);
  if (value !== null && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deserializeObjectIds(v)]));
  }
  return value;
}

export type Query = {
  database: string;
  collection: string;
  mode: "find" | "aggregate";
  filter?: Document;
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  pipeline?: Document[];
};

export async function runQuery(q: Query): Promise<Document[]> {
  const collections = DATABASES.get(q.database);
  if (!collections) throw new QueryRejected(`Unknown database "${q.database}". Valid: ${[...DATABASES.keys()].join(", ")}`);
  if (!collections.has(q.collection)) throw new QueryRejected(`Collection "${q.collection}" is not available in ${q.database}`);
  assertSafeQuery({ filter: q.filter, projection: q.projection, sort: q.sort, pipeline: q.pipeline }, collections);

  const coll = (await getClient()).db(q.database).collection(q.collection);
  if (q.mode === "aggregate") {
    const pipeline = [...(deserialize(q.pipeline ?? []) as Document[]), { $limit: MAX_ROWS }];
    return coll.aggregate(pipeline, { maxTimeMS: MAX_TIME_MS }).toArray();
  }
  return coll
    .find(deserialize(q.filter ?? {}) as Document, { maxTimeMS: MAX_TIME_MS })
    .project(q.projection ?? {})
    .sort(q.sort ?? {})
    .skip(q.skip ?? 0)
    .limit(Math.min(q.limit ?? 100, MAX_ROWS))
    .toArray();
}

function bsonType(value: unknown): string {
  if (value instanceof ObjectId) return "ObjectId";
  if (value instanceof Date) return "Date";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

let schemaPromise: Promise<string> | null = null;

/** Top-level field names/types sampled from one document per allowed collection (PII fields omitted). Cached per instance. */
export function getSchemaSummary(): Promise<string> {
  schemaPromise ??= (async () => {
    const client = await getClient();
    const blocks = await Promise.all(
      [...DATABASES].flatMap(([db, colls]) =>
        [...colls].map(async (name) => {
          const sample = await client.db(db).collection(name).findOne({}, { maxTimeMS: MAX_TIME_MS });
          const fields = Object.entries(sample ?? {})
            .filter(([k]) => !PII_FIELDS.has(k))
            .map(([k, v]) => `  ${k}: ${bsonType(v)}${v instanceof ObjectId ? "  <- use plain 24-hex string in filters" : ""}`);
          return `[${db}] Collection: ${name}\n${fields.join("\n")}`;
        })
      )
    );
    return blocks.join("\n\n");
  })().catch((err) => {
    schemaPromise = null;
    throw err;
  });
  return schemaPromise;
}
