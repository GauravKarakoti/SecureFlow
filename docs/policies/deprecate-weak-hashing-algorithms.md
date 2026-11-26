# Deprecate Weak Hashing Algorithms

## Problem

Cryptographic algorithms such as MD5, SHA-1, and DES are mathematically broken and vulnerable to practical collision attacks and pre-image attacks. Using deprecated algorithms for cryptographic signatures, digital certificates, or password verification allows attackers to generate colliding payloads or reverse credentials.

## Example

```javascript
// Vulnerable: using MD5 for password digest
const hash = crypto.createHash("md5").update(password).digest("hex");
```

## Fix

Use modern cryptographic hash functions (SHA-256 or SHA-3) for message integrity, and use memory-hard hashing schemes (Argon2id or bcrypt) for passwords.

```javascript
// Remediated: password hashing with bcrypt/Argon2
import bcrypt from "bcrypt";
const hash = await bcrypt.hash(password, 12);
```
