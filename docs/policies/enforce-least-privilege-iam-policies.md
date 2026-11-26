# Enforce Least-Privilege IAM Policies

## Problem

Infrastructure as Code definitions that grant wildcard permissions (`Action: "*"` or `Resource: "*"`) in cloud IAM policies violate the principle of least privilege, enabling compromised credentials to perform unauthorized infrastructure modifications.

## Example

```json
// Vulnerable: wildcard IAM statement
{
  "Effect": "Allow",
  "Action": "*",
  "Resource": "*"
}
```

## Fix

Specify only the exact IAM actions and target resource ARNs necessary for workload execution.

```json
// Remediated: scoped actions and resource ARNs
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::app-production-assets/*"
}
```
