---
"secureflow": patch
---

Show the Dependency Security card on the findings page. It filtered on a `DEPENDENCY_VULNERABILITY` finding type that does not exist (the SBOM worker stores dependency findings as `VULNERABILITY` with a `Dependency: name@version` snippet), so it never rendered. The card is now built from those rows, using the fields the page actually loads.
