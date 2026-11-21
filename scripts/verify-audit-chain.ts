import prisma from "../src/lib/prisma";
import { verifyAuditChain } from "../src/lib/audit/verify-chain";

async function main() {
  console.log("🔒 Verifying SecureFlow Audit Log cryptographic hash chain...");

  try {
    const args = process.argv.slice(2);
    let cursor: string | undefined;
    let limit: number | undefined;

    for (const arg of args) {
      if (arg.startsWith("--cursor=")) {
        cursor = arg.slice("--cursor=".length);
      } else if (arg.startsWith("--limit=")) {
        limit = parseInt(arg.slice("--limit=".length), 10);
      }
    }

    const result = await verifyAuditChain(prisma, { cursor, limit });

    if (result.valid) {
      console.log(`✅ Audit log chain is valid! Verified ${result.totalVerified} entries.`);
      if (result.hasMore && result.nextCursor) {
        console.log(`ℹ️  Next batch cursor: ${result.nextCursor}`);
      }
      process.exit(0);
    } else {
      console.error("❌ AUDIT LOG CHAIN INTEGRITY VIOLATION DETECTED!");
      console.error(`- Broken Entry ID: ${result.brokenEntryId || result.firstInvalidEntryId}`);
      console.error(`- Expected Hash: ${result.expectedHash}`);
      console.error(`- Actual Hash: ${result.actualHash}`);
      console.error(`- Verified entries before break: ${result.totalVerified}`);
      console.error(`- Reason: ${result.reason}`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error("💥 Error executing audit log verification:", error?.message || error);
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main();
