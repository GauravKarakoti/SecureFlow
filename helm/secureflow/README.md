# SecureFlow Kubernetes Helm Chart

Official Helm chart for deploying and scaling **SecureFlow** — the AI-powered security scanner and developer workflow platform — in a Kubernetes cluster.

---

## Architecture Overview

This chart provisions and orchestrates the complete SecureFlow topology:

- **Next.js App Server (`app`)**: Handles Mission Control web UI, REST APIs, OAuth/Auth.js flows, and GitHub webhook ingestion on port `9002`.
- **BullMQ Workers (`worker`)**: Asynchronous worker pool processing high-throughput vulnerability scanning, SBOM generation, outbound notifications, and dead-letter queue retries.
- **Database Migrations (`migration`)**: Automated Pre-install / Pre-upgrade Helm hook executing `prisma migrate deploy`.
- **Data Retention (`retention`)**: Scheduled Kubernetes `CronJob` executing retention policies.
- **Data Persistence**:
  - **PostgreSQL**: In-cluster StatefulSet or connection to external managed PostgreSQL (AWS RDS, Neon, Cloud SQL).
  - **Redis**: In-cluster StatefulSet or connection to external Redis (AWS ElastiCache, Upstash).
- **Ingress & TLS**: NGINX / Traefik Ingress with automated TLS certificate management (Cert-Manager).
- **Horizontal Pod Autoscaling (HPA)**: Independent autoscaling for web frontend and worker nodes based on CPU and memory utilization.

---

## Quickstart

### Worker egress isolation & hardening (#1755, #1767)

When `networkPolicy.enabled: true` is set, the chart enforces a **default-deny** egress policy for backend worker pods (`*-worker-egress`), blocking all outbound external connections unless explicitly whitelisted.

By default, worker pods retain outbound access only to:
1. **Cluster DNS**: UDP/TCP port `53` to the configured DNS namespace and pod selector (`kube-system` / `k8s-app: kube-dns`).
2. **In-Cluster PostgreSQL**: TCP port `5432` (automatically permitted when `postgresql.enabled: true`).
3. **In-Cluster Redis**: TCP port `6379` (automatically permitted when `redis.enabled: true`).

All other outbound traffic — including arbitrary internet destinations, cloud instance metadata services (`169.254.169.254/32`, `168.63.129.16/32`), and internal private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) — is strictly dropped by the CNI.

To allow workers to perform vulnerability scans, query LLMs, inspect container images, and communicate with external services, operators must configure explicitly whitelisted endpoints via `networkPolicy.workerEgress.whitelistedEndpoints`:

```yaml
networkPolicy:
  enabled: true
  workerEgress:
    # Explicitly whitelisted external API endpoints
    whitelistedEndpoints:
      - name: llm-providers
        description: "Inference endpoints for AI vulnerability explanations (Groq, OpenAI)"
        cidrs:
          - "104.18.0.0/20" # Example: Cloudflare CDN CIDR for api.groq.com
        ports: [443]

      - name: container-registries
        description: "Registries for image layer extraction and SBOM generation (GHCR, Docker Hub)"
        cidrs:
          - "140.82.112.0/20" # Example: GitHub CIDR for ghcr.io
        ports: [443]

      - name: github-api
        description: "GitHub REST API and raw file diff downloads"
        cidrs:
          - "140.82.112.0/20"
        ports: [443]

    # Additional custom Kubernetes egress rules (e.g. for external VPC databases or proxies)
    extraEgressRules:
      - to:
          - ipBlock:
              cidr: "10.0.10.0/24" # Private VPC database subnet
        ports:
          - protocol: TCP
            port: 5432

    # Cluster DNS service configuration
    dns:
      namespace: kube-system
      podLabels:
        k8s-app: kube-dns
      ports: [53]
```

### Required Egress Traffic Rules Reference

The following table summarizes the egress traffic destinations required by SecureFlow worker pods for standard and enterprise operations:

| Destination / Service | Purpose | Protocol / Port | Configuration Parameter | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Cluster DNS** (`CoreDNS` / `kube-dns`) | Hostname resolution for external and internal services | UDP/TCP `53` | `networkPolicy.workerEgress.dns` | Must match your Kubernetes distribution's DNS namespace and pod labels (e.g., `coredns` in EKS/k3s). |
| **In-Cluster PostgreSQL** | Audit logs, policies, findings | TCP `5432` | `postgresql.enabled: true` | Automatically permitted to same-release PostgreSQL StatefulSet. |
| **In-Cluster Redis** | Asynchronous scan queues & state | TCP `6379` | `redis.enabled: true` | Automatically permitted to same-release Redis StatefulSet. |
| **External Managed PostgreSQL** | AWS RDS, Neon, Google Cloud SQL | TCP `5432` | `networkPolicy.workerEgress.extraEgressRules` | Required when `postgresql.enabled: false`. Scope CIDR to your private database subnet. |
| **External Managed Redis** | AWS ElastiCache, Upstash, Redis Cloud | TCP `6379` / `6380` (TLS) | `networkPolicy.workerEgress.extraEgressRules` | Required when `redis.enabled: false`. Scope CIDR to your private cache subnet. |
| **LLM Inference Providers** | The Professor AI security engine (Groq, OpenAI, Anthropic) | TCP `443` | `workerEgress.whitelistedEndpoints` | Whitelist provider IP ranges (e.g. Cloudflare IP blocks for Groq `api.groq.com`). |
| **Container Image Registries** | Container image layer scanning and SBOM generation (GHCR, Docker Hub, ECR) | TCP `443` | `workerEgress.whitelistedEndpoints` | Whitelist registry IP ranges (e.g. GitHub IP meta for `ghcr.io`, Docker Hub IPs). |
| **GitHub API & Git Content** | Webhook verification, PR diffs, commit checks, security alerts | TCP `443` | `workerEgress.whitelistedEndpoints` | Whitelist ranges from [GitHub Meta API](https://api.github.com/meta) (`api`, `git`, `web`). |
| **Outbound Webhooks** | High-severity finding notifications (Slack, Discord, custom SIEM) | TCP `443` | `workerEgress.whitelistedEndpoints` | Whitelist notification gateway IPs when webhook alerts are enabled. |

> **Security Note:** Kubernetes `NetworkPolicy` operates on Layer 3 / Layer 4 (IP addresses and CIDR blocks), not DNS domain names (FQDNs). 
> - Always specify the narrowest stable public IPv4 CIDRs available. 
> - The chart's template compiler automatically validates CIDR formats and **strictly rejects** attempts to whitelist private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) or cloud metadata (`169.254.169.254/32`, `168.63.129.16/32`) addresses in `whitelistedEndpoints`.
> - If your organization utilizes dynamic IP endpoints or requires domain-level (FQDN) filtering, deploy an egress proxy (e.g., Envoy, Squid) or a CNI with L7 egress policy support (e.g., Cilium `CiliumNetworkPolicy`, Calico GlobalNetworkPolicy).

Enforcement requires a NetworkPolicy-capable CNI (e.g., Calico, Cilium, AWS VPC CNI with network policies enabled, Azure NPM). Kubernetes policies are additive: audit any cluster-wide default policies to ensure worker isolation is not unintentionally weakened. Rendered-chart tests verify configuration syntax, schema conformance, and selector contracts. See upstream [Kubernetes NetworkPolicy documentation](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

### 1. Add and inspect the chart

```bash
cd helm/secureflow
```

### 2. Install in development / standalone mode (with in-cluster Postgres & Redis)

Generate a secure random authentication secret and pass it to Helm:

```bash
AUTH_SECRET=$(openssl rand -base64 32)

helm install secureflow ./helm/secureflow \
  --set secrets.authSecret="${AUTH_SECRET}" \
  --set secrets.groqApiKey="gsk_your_groq_api_key"
```

> **Note:** A secure `secrets.authSecret` or `secrets.existingSecret` is mandatory. The chart rejects empty secrets and known placeholder values (such as `changeme*`).

### 3. Verify deployment

```bash
kubectl get pods -l "app.kubernetes.io/instance=secureflow"
```

---

## Production Deployment Configuration

For enterprise production deployments, it is recommended to connect to external managed database and Redis services and enable Ingress with TLS:

Create a `production-values.yaml`:

```yaml
app:
  replicaCount: 3
  resources:
    limits:
      cpu: 2000m
      memory: 2048Mi
    requests:
      cpu: 500m
      memory: 1024Mi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 15
    targetCPUUtilizationPercentage: 75

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
  autoscaling:
    enabled: true
    minReplicas: 4
    maxReplicas: 20
    targetCPUUtilizationPercentage: 80

ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
  hosts:
    - host: secureflow.yourdomain.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: secureflow-tls-cert
      hosts:
        - secureflow.yourdomain.com

config:
  authUrl: "https://secureflow.yourdomain.com"
  nextPublicAppUrl: "https://secureflow.yourdomain.com"
  logLevel: "info"

secrets:
  existingSecret: "secureflow-enterprise-secrets"

# Disable in-cluster Postgres and point to managed RDS/Neon
postgresql:
  enabled: false
  external:
    host: "postgres.internal.yourdomain.com"
    port: 5432
    database: "secureflow_prod"
    username: "secureflow_user"
    password: "your-db-password"
    sslmode: "require"

# Disable in-cluster Redis and point to managed ElastiCache/Redis
redis:
  enabled: false
  external:
    url: "rediss://:your-redis-password@redis.internal.yourdomain.com:6379/0"

# Enforce least-privilege network policies & worker egress hardening (#1767)
networkPolicy:
  enabled: true
  workerEgress:
    whitelistedEndpoints:
      - name: llm-providers
        description: "Groq / OpenAI inference API endpoints for AI scanning"
        cidrs:
          - "104.18.0.0/20"
        ports: [443]
      - name: container-registries
        description: "Container registries for vulnerability and SBOM analysis (GHCR, Docker Hub)"
        cidrs:
          - "140.82.112.0/20"
        ports: [443]
      - name: github-api
        description: "GitHub API and raw blob fetching for PR analysis"
        cidrs:
          - "140.82.112.0/20"
        ports: [443]
    # Allow worker egress to private VPC managed database and Redis subnets
    extraEgressRules:
      - to:
          - ipBlock:
              cidr: "10.0.10.0/24" # Private VPC subnet for external PostgreSQL and Redis
        ports:
          - protocol: TCP
            port: 5432
          - protocol: TCP
            port: 6379
```

Apply the deployment:

```bash
helm upgrade --install secureflow ./helm/secureflow -f production-values.yaml
```

---

## Configuration Reference

The chart's [`values.schema.json`](./values.schema.json) validates the merged values during
`helm lint`, `helm template`, `helm install`, and `helm upgrade`. Editors that support
YAML language server schemas can also use it for completion and type hints. Add
`# yaml-language-server: $schema=./helm/secureflow/values.schema.json` to the first
line of a values override file in the repository root; adjust the relative path
if the file is elsewhere.

The chart creates a single application Service (`*-app`). That Service also
carries the `secureflow-metrics: "true"` label and the named port
`service.portName`, which the optional ServiceMonitor selects, so each app pod
is scraped once. The Service type and port come from `app.service.*`.

| Parameter                    | Description                                     | Default          |
| ---------------------------- | ----------------------------------------------- | ---------------- |
| `app.replicaCount`           | Number of Next.js app replicas                  | `2`              |
| `app.image.repository`       | Next.js container image repository              | `secureflow/app` |
| `app.service.port`           | Application service port                        | `9002`           |
| `service.portName`           | Port name of the application Service, selected by ServiceMonitor | `http`           |
| `app.autoscaling.enabled`    | Enable HorizontalPodAutoscaler for app          | `false`          |
| `app.podDisruptionBudget.enabled`    | Enable PodDisruptionBudget for app              | `true`           |
| `app.podDisruptionBudget.minAvailable` | Minimum available app replicas during voluntary disruptions | `1` |
| `app.resources.requests`     | Enforced CPU and memory requests for app container | `cpu: 250m, memory: 512Mi, ephemeral-storage: 512Mi` |
| `app.resources.limits`       | Enforced CPU and memory limits for app container   | `cpu: 1000m, memory: 1024Mi, ephemeral-storage: 2Gi` |
| `worker.enabled`             | Enable background queue workers                 | `true`           |
| `worker.replicaCount`        | Number of worker replicas                       | `2`              |
| `worker.concurrency`         | Scan concurrency per worker                     | `5`              |
| `worker.resources.requests`  | Enforced CPU and memory requests for worker container (OOM protection during heavy AST/SBOM scans) | `cpu: 500m, memory: 1Gi, ephemeral-storage: 2Gi` |
| `worker.resources.limits`    | Enforced CPU and memory limits for worker container | `cpu: 2000m, memory: 2Gi, ephemeral-storage: 10Gi` |
| `worker.autoscaling.enabled` | Enable HorizontalPodAutoscaler for workers      | `false`          |
| `worker.podDisruptionBudget.enabled` | Enable PodDisruptionBudget for workers          | `true`           |
| `worker.podDisruptionBudget.minAvailable` | Minimum available worker replicas during voluntary disruptions | `1` |
| `worker.affinity`            | Node affinity and pod anti-affinity rules for workers | *(preconfigured for worker/compute nodes)* |
| `resourceQuota.enabled`      | Enable Kubernetes namespace ResourceQuota budget | `true`           |
| `resourceQuota.hard`         | Hard compute and object limits for the namespace | *(4 CPU / 8Gi req, 8 CPU / 16Gi limit)* |
| `limitRange.enabled`         | Enable Kubernetes LimitRange for default container bounds | `true`           |
| `limitRange.limits`          | Default requests, default limits, min and max bounds for containers | *(preconfigured defaults)* |
| `migration.enabled`          | Enable automated database schema migration hook | `true`           |
| `retention.enabled`          | Enable scheduled data retention cleanup CronJob | `true`           |
| `retention.schedule`         | Cron schedule for data retention                | `0 2 * * *`      |
| `ingress.enabled`            | Enable Ingress resource                         | `false`          |
| `ingress.className`          | Ingress controller class name                   | `nginx`          |
| `secrets.existingSecret`     | Name of pre-created secret for credentials      | `""`             |
| `secrets.authSecret`         | Authentication secret for NextAuth session JWTs (required if `existingSecret` is empty) | `""`             |
| `networkPolicy.enabled`      | Enable Kubernetes NetworkPolicies to enforce least-privilege ingress to postgresql/redis and default-deny worker egress | `false`          |
| `networkPolicy.workerEgress.whitelistedEndpoints` | Explicitly whitelisted external API endpoints with `name`, `cidrs`, `ports`, and optional `description` | `[]` |
| `networkPolicy.workerEgress.extraEgressRules` | Additional custom Kubernetes NetworkPolicy egress rule definitions | `[]` |
| `networkPolicy.workerEgress.externalCIDRs` | Public IPv4 CIDRs allowed for external worker egress (legacy flat format) | `[]` |
| `networkPolicy.workerEgress.externalPorts` | TCP destination ports permitted for `externalCIDRs` | `[443]` |
| `networkPolicy.workerEgress.dns.namespace` | Namespace of the cluster DNS service | `kube-system` |
| `networkPolicy.workerEgress.dns.podLabels` | Pod selector labels for the cluster DNS service | `k8s-app: kube-dns` |
| `networkPolicy.workerEgress.dns.ports` | Ports permitted for DNS resolution queries (UDP and TCP) | `[53]` |
| `postgresql.enabled`         | Deploy in-cluster PostgreSQL StatefulSet        | `true`           |
| `postgresql.podDisruptionBudget.enabled` | Enable PodDisruptionBudget for PostgreSQL   | `false`          |
| `postgresql.external.host`   | Hostname of external PostgreSQL instance        | `""`             |
| `redis.enabled`              | Deploy in-cluster Redis StatefulSet             | `true`           |
| `redis.podDisruptionBudget.enabled` | Enable PodDisruptionBudget for Redis            | `false`          |
| `redis.external.url`         | Connection URI for external Redis instance      | `""`             |

---

## Troubleshooting & Verification

- **Check Pod Status**:
  ```bash
  kubectl get pods -l "app.kubernetes.io/instance=secureflow"
  ```
- **Check Network Policies**:
  ```bash
  kubectl get networkpolicy -l "app.kubernetes.io/instance=secureflow"
  ```
- **Inspect Web Logs**:
  ```bash
  kubectl logs -f -l "app.kubernetes.io/component=app"
  ```
- **Inspect Queue Worker Logs**:
  ```bash
  kubectl logs -f -l "app.kubernetes.io/component=worker"
  ```
- **Inspect Migration Job Status**:
  ```bash
  kubectl get jobs -l "app.kubernetes.io/component=migration"
  ```
