# Block Unpinned Docker Base Images

## Problem
Using mutable container image tags such as `latest` or unversioned image names in Dockerfiles causes container builds to pull different upstream image layers unpredictably over time, breaking reproducibility and opening avenues for supply chain attacks.

## Example
```dockerfile
# Vulnerable: mutable image tag
FROM node:latest
WORKDIR /app
COPY . .
```

## Fix
Pin the Docker image to a specific immutable semantic version and SHA-256 digest.

```dockerfile
# Remediated: pinned image tag and sha256 digest
FROM node:20.12.2-alpine@sha256:d28a4fb58235e1a4ff27453e9...
WORKDIR /app
COPY . .
```
