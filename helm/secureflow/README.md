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

### 1. Add and inspect the chart

```bash
cd helm/secureflow
```

### 2. Install in development / standalone mode (with in-cluster Postgres & Redis)

```bash
helm install secureflow ./helm/secureflow \
  --set secrets.authSecret="a-secure-random-auth-secret-here" \
  --set secrets.groqApiKey="gsk_your_groq_api_key"
```

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
```

Apply the deployment:

```bash
helm upgrade --install secureflow ./helm/secureflow -f production-values.yaml
```

---

## Configuration Reference

| Parameter | Description | Default |
|---|---|---|
| `app.replicaCount` | Number of Next.js app replicas | `2` |
| `app.image.repository` | Next.js container image repository | `secureflow/app` |
| `app.service.port` | Application service port | `9002` |
| `app.autoscaling.enabled` | Enable HorizontalPodAutoscaler for app | `false` |
| `worker.enabled` | Enable background queue workers | `true` |
| `worker.replicaCount` | Number of worker replicas | `2` |
| `worker.concurrency` | Scan concurrency per worker | `5` |
| `worker.autoscaling.enabled` | Enable HorizontalPodAutoscaler for workers | `false` |
| `migration.enabled` | Enable automated database schema migration hook | `true` |
| `retention.enabled` | Enable scheduled data retention cleanup CronJob | `true` |
| `retention.schedule` | Cron schedule for data retention | `0 2 * * *` |
| `ingress.enabled` | Enable Ingress resource | `false` |
| `ingress.className` | Ingress controller class name | `nginx` |
| `secrets.existingSecret` | Name of pre-created secret for credentials | `""` |
| `postgresql.enabled` | Deploy in-cluster PostgreSQL StatefulSet | `true` |
| `postgresql.external.host` | Hostname of external PostgreSQL instance | `""` |
| `redis.enabled` | Deploy in-cluster Redis StatefulSet | `true` |
| `redis.external.url` | Connection URI for external Redis instance | `""` |

---

## Troubleshooting & Verification

- **Check Pod Status**:
  ```bash
  kubectl get pods -l "app.kubernetes.io/instance=secureflow"
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
