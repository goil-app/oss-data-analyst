import { MongoClient, MongoClientOptions, ObjectId } from "mongodb";
import { getDatabaseConfigs, validateDatabase } from "./database-registry";

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Recursively converts 24-hex strings to ObjectId so agent filters match stored ObjectId fields.
 */
function deserializeObjectIds(value: any): any {
  if (typeof value === "string" && OBJECT_ID_REGEX.test(value)) {
    return new ObjectId(value);
  }
  if (Array.isArray(value)) {
    return value.map(deserializeObjectIds);
  }
  if (value !== null && typeof value === "object" && !(value instanceof ObjectId)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deserializeObjectIds(v)]));
  }
  return value;
}

let client: MongoClient | null = null;
let clientPromise: Promise<MongoClient> | null = null;

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/oss-data-analyst";

/**
 * Get or create MongoDB client connection
 */
export function getMongoClient(): Promise<MongoClient> {
  if (clientPromise) {
    return clientPromise;
  }

  const options: MongoClientOptions = {
    maxPoolSize: 10,
    minPoolSize: 1,
  };

  console.log(`[MongoDB] Connecting to: ${MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@')}`);

  clientPromise = MongoClient.connect(MONGODB_URI, options)
    .then((c) => {
      client = c;
      console.log("[MongoDB] Connected successfully");
      return c;
    })
    .catch((err) => {
      clientPromise = null;
      console.error("[MongoDB] Connection failed:", err.message);
      throw err;
    });

  return clientPromise;
}

/**
 * Extract database name from URI (fallback when MONGODB_DATABASES not configured)
 */
function extractDbName(uri: string): string {
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : "oss-data-analyst";
}

/**
 * Get default database name
 * - If MONGODB_DATABASES is configured, returns first database
 * - Otherwise extracts from URI path
 */
export function getDefaultDatabaseName(): string {
  const configs = getDatabaseConfigs();
  if (configs.length > 0) {
    return configs[0].name;
  }
  return extractDbName(MONGODB_URI);
}

/**
 * Get database instance by name
 * @param dbName - Database name (required in multi-db mode)
 */
export async function getDatabase(dbName?: string): Promise<ReturnType<MongoClient["db"]>> {
  const client = await getMongoClient();

  // Determine database name
  const configs = getDatabaseConfigs();
  let name: string;

  if (dbName) {
    // Validate if in multi-db mode
    if (configs.length > 0) {
      validateDatabase(dbName);
    }
    name = dbName;
  } else if (configs.length > 0) {
    // Multi-db mode but no name specified - use first
    name = configs[0].name;
    console.log(`[MongoDB] No database specified, using default: ${name}`);
  } else {
    // Single-db mode - extract from URI
    name = extractDbName(MONGODB_URI);
  }

  return client.db(name);
}

/**
 * Get list of configured database names
 */
export function getConfiguredDatabaseNames(): string[] {
  const configs = getDatabaseConfigs();
  if (configs.length > 0) {
    return configs.map(c => c.name);
  }
  // Fallback: return URI database name
  return [extractDbName(MONGODB_URI)];
}

/**
 * Query result format
 */
export interface QueryResult {
  rows: any[];
  columns: string[];
  rowCount: number;
  executionTime: number;
}

/**
 * Execute a MongoDB find query
 */
export async function executeFindQuery(params: {
  database?: string;
  collection: string;
  filter?: Record<string, any>;
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}): Promise<QueryResult> {
  const startTime = Date.now();
  const dbInfo = params.database ? `${params.database}.${params.collection}` : params.collection;
  console.log(`[MongoDB] Find on ${dbInfo}`);

  try {
    const db = await getDatabase(params.database);
    const collection = db.collection(params.collection);

    let cursor = collection.find(deserializeObjectIds(params.filter || {}));

    if (params.projection) {
      cursor = cursor.project(params.projection);
    }
    if (params.sort) {
      cursor = cursor.sort(params.sort);
    }
    if (params.skip) {
      cursor = cursor.skip(params.skip);
    }
    if (params.limit) {
      cursor = cursor.limit(params.limit);
    }

    const rows = await cursor.toArray();
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const executionTime = Date.now() - startTime;

    console.log(`[MongoDB] Query completed in ${executionTime}ms, returned ${rows.length} docs`);

    return {
      rows,
      columns,
      rowCount: rows.length,
      executionTime,
    };
  } catch (error: any) {
    const executionTime = Date.now() - startTime;
    console.error(`[MongoDB] Query failed after ${executionTime}ms:`, error.message);
    throw new Error(`MongoDB Error: ${error.message}`);
  }
}

/**
 * Execute a MongoDB aggregation pipeline
 */
export async function executeAggregation(params: {
  database?: string;
  collection: string;
  pipeline: Record<string, any>[];
}): Promise<QueryResult> {
  const startTime = Date.now();
  const dbInfo = params.database ? `${params.database}.${params.collection}` : params.collection;
  console.log(`[MongoDB] Aggregation on ${dbInfo}`);

  try {
    const db = await getDatabase(params.database);
    const collection = db.collection(params.collection);

    const rows = await collection.aggregate(deserializeObjectIds(params.pipeline)).toArray();
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const executionTime = Date.now() - startTime;

    console.log(`[MongoDB] Aggregation completed in ${executionTime}ms, returned ${rows.length} docs`);

    return {
      rows,
      columns,
      rowCount: rows.length,
      executionTime,
    };
  } catch (error: any) {
    const executionTime = Date.now() - startTime;
    console.error(`[MongoDB] Aggregation failed after ${executionTime}ms:`, error.message);
    throw new Error(`MongoDB Error: ${error.message}`);
  }
}

function getBsonType(value: any): string {
  if (value instanceof ObjectId) return "ObjectId";
  if (value instanceof Date) return "Date";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (typeof value === "boolean") return "bool";
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value; // string, object
}

/**
 * Get collection schema information
 */
export async function getSchema(dbName?: string): Promise<any[]> {
  const db = await getDatabase(dbName);
  const collections = await db.listCollections().toArray();

  const schemas = await Promise.all(
    collections.map(async (col) => {
      const sample = await db.collection(col.name).findOne();
      const indexes = await db.collection(col.name).indexes();

      return {
        collection: col.name,
        fields: sample
          ? Object.entries(sample).map(([name, value]) => ({
              name,
              bsonType: getBsonType(value),
            }))
          : [],
        indexes: indexes.map((idx) => ({ name: idx.name, keys: idx.key })),
      };
    })
  );

  return schemas;
}

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = await getMongoClient();
    await client.db().admin().ping();
    console.log("[MongoDB] Connection test successful");
    return true;
  } catch (error) {
    console.error("[MongoDB] Connection test failed:", error);
    return false;
  }
}

/**
 * Close database connection
 */
export async function closeDatabase(): Promise<void> {
  if (client) {
    console.log("[MongoDB] Closing connection");
    await client.close();
    client = null;
    clientPromise = null;
  }
}

/**
 * List all collections in the database
 */
export async function listCollections(dbName?: string): Promise<string[]> {
  const db = await getDatabase(dbName);
  const collections = await db.listCollections().toArray();
  return collections.map((c) => c.name);
}
