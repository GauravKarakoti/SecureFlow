import { prisma } from '@/lib/prisma';
import { Severity } from '@prisma/client';

/**
 * Resolves the effective security policies for a given repository.
 * It follows the hierarchy: Repository Overrides > Organization Policies > Default System Policies.
 *
 * @param repoId - The unique identifier of the repository.
 * @param orgId - The unique identifier of the organization (optional).
 * @returns A merged array of effective policies.
 */
export async function resolveEffectivePolicies(repoId: string, orgId?: string) {
  // 1. Fetch repository-specific policies (overrides)
  const repoPolicies = await prisma.policy.findMany({
    where: { repositoryId: repoId },
    select: { name: true, isEnabled: true, severity: true, isOverridden: true }
  });

  const repoPolicyMap = new Map(repoPolicies.map(p => [p.name, p]));

  // 2. Fetch organization-level policies if orgId is provided
  let orgPolicies = [];
  if (orgId) {
    orgPolicies = await prisma.orgPolicy.findMany({
      where: { organizationId: orgId },
      select: { name: true, isEnabled: true, severity: true, isOverridden: true }
    });
  }

  // 3. Fetch default system policies (seeded templates)
  const defaultPolicies = await prisma.policy.findMany({
    where: { repositoryId: null, isDefault: true },
    select: { name: true, isEnabled: true, severity: true }
  });

  // 4. Merge policies based on precedence
  const effectivePolicies = new Map<string, { name: string; isEnabled: boolean; severity: Severity; source: string }>();

  // Apply defaults first (lowest precedence)
  defaultPolicies.forEach(p => {
    effectivePolicies.set(p.name, { ...p, source: 'DEFAULT' });
  });

  // Apply org policies (medium precedence)
  orgPolicies.forEach(p => {
    effectivePolicies.set(p.name, { ...p, source: 'ORGANIZATION' });
  });

  // Apply repo policies (highest precedence)
  repoPolicyMap.forEach((p, name) => {
    effectivePolicies.set(name, { ...p, source: 'REPOSITORY' });
  });

  return Array.from(effectivePolicies.values());
}

/**
 * Creates or updates an organization-level policy.
 */
export async function upsertOrgPolicy(orgId: string, name: string, description: string, severity: Severity, isEnabled: boolean) {
  return prisma.orgPolicy.upsert({
    where: { organizationId_name: { organizationId: orgId, name } },
    update: { description, severity, isEnabled, isOverridden: false },
    create: { organizationId: orgId, name, description, severity, isEnabled, isOverridden: false }
  });
}
