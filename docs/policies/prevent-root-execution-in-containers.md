# Prevent Root Execution in Containers

## Problem

Executing containerized processes as the root user (UID 0) removes container isolation boundaries if a breakout vulnerability exists in the runtime (e.g., runc CVEs). A compromised root container process can obtain full host root equivalence.

## Example

```dockerfile
# Vulnerable: missing USER directive leaves default root execution
FROM node:20-alpine
WORKDIR /app
COPY . .
CMD ["node", "server.js"]
```

## Fix

Specify a dedicated non-root user and group in the Dockerfile, or enforce non-root security contexts in Kubernetes.

```dockerfile
# Remediated: execute with non-privileged node user
FROM node:20-alpine
WORKDIR /app
COPY . .
USER node
CMD ["node", "server.js"]
```
