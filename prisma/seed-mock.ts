import prisma from "../src/lib/prisma";

async function main() {
  console.log("Starting mock database seed...");

  // Generate massive array of 50+ mock AuditLogs
  const mockLogs = [];
  const actions = ["USER_LOGIN", "SCAN_INITIATED", "THREAT_DETECTED", "POLICY_UPDATED", "PR_MERGED", "REPO_LINKED"];
  const resources = ["Authentication Service", "GitHub Scanner", "Policy Engine", "GitHub Webhook", "Settings"];
  const decisions = ["ALLOW", "BLOCK", "REVIEW", "NONE"];

  for (let i = 0; i < 60; i++) {
    const action = actions[Math.floor(Math.random() * actions.length)];
    const resource = resources[Math.floor(Math.random() * resources.length)];
    const decision = decisions[Math.floor(Math.random() * decisions.length)];
    
    // Distribute timestamps over the last 30 days
    const date = new Date();
    date.setDate(date.getDate() - Math.floor(Math.random() * 30));

    mockLogs.push({
      action,
      resource,
      decision,
      metadata: { source: "SEED", ip: `192.168.1.${Math.floor(Math.random() * 255)}` },
      timestamp: date,
    });
  }

  // Use createMany to insert logs
  const createdLogs = await prisma.auditLog.createMany({
    data: mockLogs,
  });

  console.log(`Created ${createdLogs.count} AuditLog entries.`);
  console.log("Mock seeding finished.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
