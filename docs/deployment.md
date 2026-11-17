# SecureFlow Deployment & Egress Hardening Guide

This guide documents production deployment architecture, security hardening practices, and the required network egress rules for running **SecureFlow** in enterprise Kubernetes environments.

---

## 1. Architecture & Network Topology

SecureFlow orchestrates multiple decoupled services in a production Kubernetes cluster:

- **App Server (`app`)**: Next.js App Router providing web dashboard, REST APIs, and webhook ingress.
- **Backend Queue Workers (`worker`)**: Asynchronous worker pool processing static AST security analysis, SBOM generation, container vulnerability checks, LLM reasoning, and GitHub status synchronization.
- **Database Migrations (`migration`)**: Helm lifecycle hook running Prisma schema migrations.
- **Data Retention (`retention`)**: Kubernetes CronJob purging expired scan logs and telemetry.
- **Data Persistence**: PostgreSQL (in-cluster StatefulSet or managed RDS/Neon) and Redis (in-cluster StatefulSet or managed ElastiCache).

```
                      ┌──────────────────────┐
                      │    Ingress / TLS     │
                      └──────────┬───────────┘
                                 │
                     ┌───────────▼───────────┐
                     │   App Pods (Next.js)  │
                     └─────┬───────────┬─────┘
                           │           │
                   Enqueues│           │Audit Logs
                           ▼           ▼
        ┌─────────────────────┐     ┌─────────────────────┐
        │   Redis Queue / DB  │     │   PostgreSQL DB     │
        └──────────▲──────────┘     └──────────▲──────────┘
                   │                           │
                   │Dequeues Jobs              │Persists Findings
                   │                           │
             ┌─────┴───────────────────────────┴─────┐
             │         Worker Pods (BullMQ)          │
             │   (Hardened Egress NetworkPolicy)     │
             └───────────────────┬───────────────────┘
                                 │
           Default Deny Egress Except Whitelisted Endpoints
                                 │
         ┌───────────────────────┼───────────────────────┐
         │ (TCP 443)             │ (TCP 443)             │ (UDP/TCP 53)
         ▼                       ▼                       ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  LLM Providers   │   │ Container / OCI  │   │   Cluster DNS    │
│  (Groq, OpenAI)  │   │ Registries (GHCR)│   │   (CoreDNS)      │
└──────────────────┘   └──────────────────┘   └──────────────────┘
```

---

## 2. Worker Egress Hardening & Default-Deny Policy

In standard Kubernetes installations, pod egress traffic is unrestricted by default (`allow-all`). If a container dependency or scanning job is exploited, unrestricted egress presents severe risks:

- Malicious exfiltration of source code or scanned repository secrets.
- Communication with Command and Control (C2) servers.
- Probing internal cluster services and cloud provider instance metadata endpoints (`169.254.169.254`).

To eliminate these attack vectors, SecureFlow implements a **Zero-Trust Default-Deny Egress NetworkPolicy** for worker pods (`*-worker-egress`):

- All outbound traffic to public IP addresses and external networks is blocked by default.
- Worker pods can only communicate with internal cluster DNS and explicitly whitelisted API destinations.
- Cloud metadata endpoints (`169.254.169.254/32`, `168.63.129.16/32`) and private RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) are strictly blocked and cannot be allowed via public egress blocks.

---

## 3. Required Egress Traffic Rules Reference

When deploying SecureFlow with `networkPolicy.enabled: true`, operators must configure the following egress rules depending on enabled features:

| Target Destination                       | Purpose                                                   | Protocol & Port     | Helm Configuration Parameter        | Destination CIDR Notes                                                                   |
| :--------------------------------------- | :-------------------------------------------------------- | :------------------ | :---------------------------------- | :--------------------------------------------------------------------------------------- |
| **Cluster DNS** (`kube-dns` / `CoreDNS`) | Resolves domain names for internal and external endpoints | UDP & TCP `53`      | `networkPolicy.workerEgress.dns`    | Targets `kube-system` namespace with label `k8s-app: kube-dns` (or your CNI DNS labels). |
| **In-Cluster PostgreSQL**                | Internal database state & audit logs                      | TCP `5432`          | `postgresql.enabled: true`          | Automatically permitted to same-release PostgreSQL StatefulSet.                          |
| **In-Cluster Redis**                     | Asynchronous job queues                                   | TCP `6379`          | `redis.enabled: true`               | Automatically permitted to same-release Redis StatefulSet.                               |
| **LLM Inference Providers**              | The Professor AI security engine (Groq, OpenAI)           | TCP `443`           | `workerEgress.whitelistedEndpoints` | Groq `api.groq.com` (Cloudflare CDN CIDRs) or OpenAI `api.openai.com`.                   |
| **Container Registries**                 | Container image layer scanning and SBOM generation        | TCP `443`, `8443`   | `workerEgress.whitelistedEndpoints` | GitHub Container Registry `ghcr.io`, Docker Hub `registry-1.docker.io`, AWS ECR, Quay.   |
| **GitHub API & VCS**                     | Webhook verification, commit checks, PR diffs             | TCP `443`           | `workerEgress.whitelistedEndpoints` | Public CIDRs from official [GitHub Meta API](https://api.github.com/meta).               |
| **Managed Cloud DB (VPC)**               | AWS RDS, Neon, Cloud SQL                                  | TCP `5432`          | `workerEgress.extraEgressRules`     | Private database subnet CIDR within the VPC.                                             |
| **Managed Cloud Cache (VPC)**            | AWS ElastiCache, Upstash                                  | TCP `6379` / `6380` | `workerEgress.extraEgressRules`     | Private cache subnet CIDR within the VPC.                                                |
| **Outbound Webhooks**                    | High-severity finding notifications (Slack, Discord)      | TCP `443`           | `workerEgress.whitelistedEndpoints` | Notification gateway IP ranges.                                                          |

---

## 4. Production Helm Configuration Example

Create a hardened `production-values.yaml`:

```yaml
# Helm values for hardened production deployment
app:
  replicaCount: 3
  resources:
    limits:
      cpu: 2000m
      memory: 2048Mi
    requests:
      cpu: 500m
      memory: 1024Mi

worker:
  replicaCount: 4
  concurrency: 10
  resources:
    limits:
      cpu: 2000m
      memory: 2048Mi
    requests:
      cpu: 500m
      memory: 1024Mi

# External managed infrastructure
postgresql:
  enabled: false
  external:
    host: "postgres.internal.vpc.local"
    port: 5432
    database: "secureflow_prod"
    username: "secureflow_user"

redis:
  enabled: false
  external:
    url: "rediss://:auth@redis.internal.vpc.local:6379/0"

# Tightened NetworkPolicy configurations (#1767)
networkPolicy:
  enabled: true
  workerEgress:
    whitelistedEndpoints:
      - name: llm-providers
        description: "Groq / OpenAI API endpoints for AI security analysis"
        cidrs:
          - "104.18.0.0/20" # Cloudflare range for api.groq.com
        ports: [443]

      - name: container-registries
        description: "Container registries for SBOM and vulnerability inspection"
        cidrs:
          - "140.82.112.0/20" # GitHub CIDR for ghcr.io
        ports: [443]

      - name: github-api
        description: "GitHub API and raw blob fetching for PR diffs"
        cidrs:
          - "140.82.112.0/20"
        ports: [443]

    # Allow worker access to private VPC database and cache subnets
    extraEgressRules:
      - to:
          - ipBlock:
              cidr: "10.0.10.0/24"
        ports:
          - protocol: TCP
            port: 5432
          - protocol: TCP
            port: 6379

    dns:
      namespace: kube-system
      podLabels:
        k8s-app: kube-dns
      ports: [53]
```

Deploy or upgrade the Helm release:

```bash
helm upgrade --install secureflow ./helm/secureflow -f production-values.yaml
```

---

## 5. Verification & Diagnostics

1. **Verify NetworkPolicies are applied**:

   ```bash
   kubectl get networkpolicy -l "app.kubernetes.io/instance=secureflow"
   ```

2. **Inspect worker egress rules**:

   ```bash
   kubectl describe networkpolicy <release-name>-worker-egress
   ```

3. **Verify blocked egress from worker pods**:

   ```bash
   # Connection to unauthorized external IP or cloud metadata service should time out:
   kubectl exec -it deployment/<release-name>-worker -- curl --connect-timeout 3 http://169.254.169.254/latest/meta-data/
   ```

4. **Verify permitted egress to whitelisted endpoints**:
   ```bash
   # Connection to whitelisted provider endpoint should succeed:
   kubectl exec -it deployment/<release-name>-worker -- curl --connect-timeout 5 https://api.groq.com/openai/v1/models
   ```
