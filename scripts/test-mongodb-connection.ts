import { testConnection, listCollections, getSchema } from "../src/lib/mongodb";

async function main() {
  console.log("🔌 Testing MongoDB connection...\n");

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/oss-data-analyst";
  console.log(`📍 URI: ${uri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@')}\n`);

  try {
    // Test connection
    const connected = await testConnection();
    if (!connected) {
      console.error("❌ Failed to connect to MongoDB");
      process.exit(1);
    }
    console.log("✅ Connected successfully\n");

    // List collections
    console.log("📁 Collections:");
    const collections = await listCollections();
    if (collections.length === 0) {
      console.log("   (no collections found - database may be empty)\n");
      console.log("💡 Tip: Create collections by inserting documents, or use a seed script.");
    } else {
      for (const col of collections) {
        console.log(`   - ${col}`);
      }
      console.log("");

      // Show schema info
      console.log("📊 Schema overview:");
      const schema = await getSchema();
      for (const s of schema) {
        console.log(`\n   ${s.collection}:`);
        console.log(`     Fields: ${s.fields.slice(0, 5).join(", ")}${s.fields.length > 5 ? "..." : ""}`);
      }
    }

    console.log("\n✅ Connection test passed!");
    process.exit(0);
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main();
