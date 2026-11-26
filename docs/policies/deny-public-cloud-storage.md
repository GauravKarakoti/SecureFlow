# Deny Public Cloud Storage

## Problem
Provisioning Infrastructure as Code (Terraform, CloudFormation, Pulumi) that marks cloud storage buckets (AWS S3, GCP Cloud Storage) as publicly readable or writable exposes private data, database dumps, and application assets to unauthorized public internet scans.

## Example
```hcl
# Vulnerable: S3 bucket declared with public-read ACL
resource "aws_s3_bucket" "artifacts" {
  bucket = "company-internal-artifacts"
  acl    = "public-read"
}
```

## Fix
Enforce S3 Public Access Blocks and configure bucket access policies with least-privilege IAM roles.

```hcl
# Remediated: private bucket with public access block
resource "aws_s3_bucket" "artifacts" {
  bucket = "company-internal-artifacts"
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```
