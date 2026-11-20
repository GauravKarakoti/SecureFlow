# Local Inference & Worker HPA Architecture Guide (#1797)

## Overview

This guide details the Helm deployment architecture for local AI inference workloads and dynamic Horizontal Pod Autoscaler (HPA) queue triggers introduced in issue #1797.

In high-throughput enterprise deployments or air-gapped / sovereign cloud environments where cloud inference APIs (e.g., Groq, OpenAI) cannot be used or where zero egress is mandated, SecureFlow workers can delegate security analysis, AST remediation, and explanation streaming to locally hosted LLM instances (such as Ollama, vLLM, or LocalAI).

---

## 1. Local AI Inference Architecture

When `worker.localInference.enabled: true` is configured in `values.yaml`, worker pods receive explicit environment variables that interface directly with SecureFlow's AI resilience engine (`src/ai/resilience.ts` and `src/ai/local-model.ts`):

- `LOCAL_AI_URL`: The HTTP/S URL of the OpenAI-compatible local model server.
- `LOCAL_AI_MODEL`: The primary model identifier (e.g., `llama3`, `deepseek-r1`).
- `LOCAL_AI_FALLBACK_MODELS`: Comma-separated fallback models tried sequentially if primary model execution exceeds memory limits (e.g., `llama3.2:3b,llama3.2:1b`).
- `VRAM_CONCURRENCY_THRESHOLD` & `LOCAL_AI_MAX_CONCURRENCY`: Upper bound of concurrent inference generations permitted per worker pod to prevent GPU Out-of-Memory (OOM) crashes.
- `LOCAL_AI_MAX_QUEUE_WAIT_MS`: Timeout before pending local model generations fail over or throw `VRAMConcurrencyError`.

### Hardware Acceleration & GPU Resources

Local inference containers require dedicated GPU access. The Helm chart exposes configurable GPU resource requests and limits under `worker.localInference.resources`. When specified, these resource definitions are merged into the worker container specification:

```yaml
worker:
  localInference:
    enabled: true
    url: "http://ollama.ai.svc.cluster.local:11434/v1"
    model: "llama3"
    fallbackModels: "llama3.2:3b,llama3.2:1b"
    vramConcurrencyThreshold: 2
    maxQueueWaitMs: 30000
    resources:
      limits:
        nvidia.com/gpu: 1
      requests:
        nvidia.com/gpu: 1
```

---

## 2. Queue-Depth Based HPA Autoscaling

Standard CPU and memory utilization metrics often lag behind asynchronous queue traffic spikes in worker pools. Under burst conditions (such as monorepo scans or release tag CI runs), scan jobs accumulate in BullMQ queues without immediately saturating worker CPU.

Issue #1797 enables direct BullMQ queue-length scaling via Kubernetes HPA external metric triggers:

```yaml
worker:
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 15
    targetCPUUtilizationPercentage: 80
    targetMemoryUtilizationPercentage: 80
    queueTrigger:
      enabled: true
      metricName: secureflow_bullmq_scan_queue_waiting
      targetAverageValue: 10
      metricType: Value # or AverageValue
```

### Metrics Adapter Integration

The `queueTrigger` metric can be provided by:

1. **Prometheus Adapter (`k8s-prometheus-adapter`)**: Maps BullMQ queue depth metrics exported to Prometheus into custom/external Kubernetes metric resources.
2. **KEDA (Kubernetes Event-driven Autoscaling)**: External metrics server translating Redis `LLEN` / BullMQ queue depths into HPA external metrics.

---

## 3. Configuration Reference

| Parameter                                            | Type                               | Default                                                        | Description                                       |
| :--------------------------------------------------- | :--------------------------------- | :------------------------------------------------------------- | :------------------------------------------------ |
| `worker.localInference.enabled`                      | boolean                            | `false`                                                        | Enable local model inference support in workers   |
| `worker.localInference.url`                          | string                             | `http://ollama.ai.svc.cluster.local:11434/v1`                  | Local model endpoint URL                          |
| `worker.localInference.model`                        | string                             | `llama3`                                                       | Primary local inference model identifier          |
| `worker.localInference.fallbackModels`               | string                             | `llama3.2:3b,llama3.2:1b`                                      | Models to fall back to during VRAM exhaustion     |
| `worker.localInference.vramConcurrencyThreshold`     | integer                            | `1`                                                            | Max concurrent GPU generations per worker         |
| `worker.localInference.maxQueueWaitMs`               | integer                            | `30000`                                                        | Max wait time before timing out local inference   |
| `worker.localInference.resources`                    | object                             | `{limits: {nvidia.com/gpu: 1}, requests: {nvidia.com/gpu: 1}}` | GPU hardware resource allocation                  |
| `worker.autoscaling.queueTrigger.enabled`            | boolean                            | `false`                                                        | Enable external queue-depth metric trigger in HPA |
| `worker.autoscaling.queueTrigger.metricName`         | string                             | `secureflow_bullmq_scan_queue_waiting`                         | Metric name queried from external metrics API     |
| `worker.autoscaling.queueTrigger.targetAverageValue` | integer                            | `10`                                                           | Value or AverageValue target threshold            |
| `worker.autoscaling.queueTrigger.metricType`         | string (`Value` \| `AverageValue`) | `Value`                                                        | Target metric specification type                  |
