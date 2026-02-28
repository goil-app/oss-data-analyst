/**
 * Database Registry - Manages multi-database configuration for MongoDB
 *
 * Databases are configured via MONGODB_DATABASES env var:
 * MONGODB_DATABASES=AnalyticsDB,ConfigDB
 */

export interface DatabaseConfig {
  name: string;
}

let cachedConfigs: DatabaseConfig[] | null = null;

/**
 * Parse database configurations from environment
 */
export function getDatabaseConfigs(): DatabaseConfig[] {
  if (cachedConfigs) return cachedConfigs;

  const envValue = process.env.MONGODB_DATABASES;

  if (!envValue) {
    // Fallback: single database from URI (will be extracted in mongodb.ts)
    cachedConfigs = [];
    return cachedConfigs;
  }

  cachedConfigs = envValue
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(name => ({ name }));

  console.log(`[DatabaseRegistry] Loaded ${cachedConfigs.length} database configs: ${cachedConfigs.map(c => c.name).join(", ")}`);
  return cachedConfigs;
}

/**
 * Get list of configured database names
 */
export function getDatabaseNames(): string[] {
  return getDatabaseConfigs().map((c) => c.name);
}

/**
 * Check if a database name is valid
 */
export function isValidDatabase(name: string): boolean {
  const configs = getDatabaseConfigs();
  if (configs.length === 0) return true; // Allow any if not configured (fallback mode)
  return configs.some((c) => c.name === name);
}

/**
 * Validate database name, throws if invalid
 */
export function validateDatabase(name: string): void {
  if (!isValidDatabase(name)) {
    const validNames = getDatabaseNames();
    if (validNames.length === 0) {
      throw new Error(`Database "${name}" is not available`);
    }
    throw new Error(
      `Unknown database "${name}". Valid databases: ${validNames.join(", ")}`
    );
  }
}

/**
 * Get database config by name
 */
export function getDatabaseConfig(name: string): DatabaseConfig | undefined {
  return getDatabaseConfigs().find((c) => c.name === name);
}

/**
 * Clear cache (for testing)
 */
export function clearCache(): void {
  cachedConfigs = null;
}
