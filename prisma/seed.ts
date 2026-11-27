import prisma from "../src/lib/prisma";
import { BUILT_IN_POLICIES } from "../src/lib/policies/built-in";

async function main() {
  console.log("Starting production database seed...");

  // 1. Create Roles
  const adminRole = await prisma.role.upsert({
    where: { name: "ADMIN" },
    update: {},
    create: { name: "ADMIN", description: "Full administrative access" },
  });

  const userRole = await prisma.role.upsert({
    where: { name: "USER" },
    update: {},
    create: { name: "USER", description: "Standard user access" },
  });

  console.log("Created Roles:", { adminRole, userRole });

  // 2. Policy Templates
  console.log("Seeding Policy Templates...");
  await prisma.policyTemplate.createMany({
    skipDuplicates: true,
    data: BUILT_IN_POLICIES.map((p) => ({
      name: p.name,
      description: p.description,
      severity: p.severity,
      action: p.action,
      isDefault: p.isDefault,
      rules: p.rules,
      helpUrl: p.helpUrl,
      guidance: p.guidance,
    })),
  });

  console.log("Successfully seeded advanced policy templates!");
  console.log("Seeding finished.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e: unknown) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
