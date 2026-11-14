---
"secureflow": patch
---

Restrict worker egress when chart NetworkPolicy is enabled: require explicit public IPv4 destination CIDRs, preserve DNS and same-release database connections, exclude private and metadata addresses, and test worker PDB selectors. No database migrations or AI flow changes.

Restore CI validation with a non-production Helm secret fixture, readonly Vitest reporter inputs, and Prisma 7 drift options using a separate ephemeral shadow database.
