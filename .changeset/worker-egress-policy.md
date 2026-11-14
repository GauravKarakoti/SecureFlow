---
"secureflow": patch
---

Restrict worker egress when chart NetworkPolicy is enabled: require explicit public IPv4 destination CIDRs, preserve DNS and same-release database connections, exclude private and metadata addresses, and test worker PDB selectors. No database migrations or AI flow changes.
