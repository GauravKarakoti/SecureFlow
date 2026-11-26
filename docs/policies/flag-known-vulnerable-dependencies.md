# Flag Known-Vulnerable Dependencies

## Problem
Including open-source dependencies or libraries with published High or Critical Common Vulnerabilities and Exposures (CVEs) enables attackers to exploit well-documented remote code execution, prototype pollution, or denial of service attack vectors.

## Example
```json
// Vulnerable: package version with known remote code execution CVE
"dependencies": {
  "axios": "0.18.0"
}
```

## Fix
Upgrade the vulnerable package to a patched release or apply a vendor security patch.

```json
// Remediated: upgraded to safe version
"dependencies": {
  "axios": "^1.7.0"
}
```
