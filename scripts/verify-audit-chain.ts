import prisma from "../src/lib/prisma";
import { verifyAuditChain } from "../src/lib/audit/verify-chain";

async function main() {
  console.log("🔒 Verifying SecureFlow Audit Log cryptographic hash chain...");

  try {
    const result = await verifyAuditChain(prisma);

    if (result.valid) {
      console.log(`✅ Audit log chain is valid! Verified ${result.totalVerified} entries.`);
      process.exit(0);
    } else {
      console.error("❌ AUDIT LOG CHAIN INTEGRITY VIOLATION DETECTED!");
      console.error(`- Broken Entry ID: ${result.brokenEntryId}`);
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
