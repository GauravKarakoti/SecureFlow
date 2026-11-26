# Prevent PII Logging

## Problem
Logging Personally Identifiable Information (PII) such as unmasked credit card numbers, passwords, Social Security Numbers (SSNs), or email addresses exposes sensitive customer data in plain text across centralized logging pipelines, SIEM collectors, and developer console outputs. This violates data protection regulations (GDPR, CCPA, PCI-DSS) and elevates breach risks.

## Example
```javascript
// Vulnerable: logging full credit card and customer billing payload
console.log(`Processing card payment: ${req.body.cardNumber} for ${req.body.cardHolder}`);
```

## Fix
Redact, mask, or hash sensitive PII fields before sending log messages to stdout or disk collectors.

```javascript
// Remediated: mask card numbers to last 4 digits and omit CVV/passwords
const maskedCard = `****-****-****-${String(req.body.cardNumber).slice(-4)}`;
logger.info("Processing card payment", { last4: maskedCard, cardHolder: req.body.cardHolder });
```
