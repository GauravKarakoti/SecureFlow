# Local Model & VRAM Configuration

SecureFlow supports completely **air-gapped, zero-cloud-egress security scanning** (`src/ai/local-model.ts`, `packages/cli/src/lib/local-mode.ts`). This allows development and security teams to scan proprietary or sensitive codebases entirely on-premises using locally-hosted Large Language Models (LLMs) rather than sending code diffs to cloud AI providers.

---

## Architecture Overview

When local mode is activated:

1. **Zero External Egress**: The hosted AI API pass (`/api/cli/scan`) is completely bypassed. Staged source code remains strictly in-memory on the local workstation or within the private network.
2. **OpenAI-Compatible Transport**: Inference calls route through `@genkit-ai/compat-oai` to any local OpenAI-compatible HTTP endpoint exposing `/v1` (e.g., Ollama or vLLM).
3. **Defense-in-Depth Preserved**: All heuristic scanners, pre-commit checks, prompt injection pre-filters, and Zod output validation schemas execute identically to cloud mode.
4. **Resilient Memory Management**: Out-Of-Memory (OOM) errors and VRAM constraints are intercepted with graceful fallback sequences (`LOCAL_AI_FALLBACK_MODELS`).

```text
┌────────────────────────────────────────────────────────┐
│               SecureFlow CLI / Core                    │
│   (Heuristic Scanner + Zod Validation + Prompt Guard)  │
└──────────────────────────┬─────────────────────────────┘
                           │ OpenAI-compatible HTTP (/v1)
                           ▼
┌────────────────────────────────────────────────────────┐
│            Local Inference Provider                    │
│  - Ollama (http://localhost:11434/v1)                  │
│  - vLLM   (http://localhost:8000/v1)                   │
│  - Custom On-Prem Gateway                              │
└────────────────────────────────────────────────────────┘
```

---

## Supported Providers & Default Endpoints

The codebase implements built-in defaults for the two most common local inference engines:

| Provider   | Default Base URL            | Default Model                           | Provider Identifier |
| :--------- | :-------------------------- | :-------------------------------------- | :------------------ |
| **Ollama** | `http://localhost:11434/v1` | `llama3`                                | `ollama`            |
| **vLLM**   | `http://localhost:8000/v1`  | `meta-llama/Meta-Llama-3-8B-Instruct`   | `vllm`              |
| **Custom** | Derived from URL            | `llama3` (or vLLM default if port 8000) | `custom`            |

### URL Normalization (`normalizeLocalAiUrl`)

- URLs are automatically normalized to guarantee a valid `/v1` path (e.g., `http://localhost:11434` becomes `http://localhost:11434/v1`).
- Custom API gateways with explicit path prefixes are preserved without appending redundant `/v1` segments.

### Air-Gapped Network Verification (`isAirGappedEndpoint`)

SecureFlow validates that the configured inference endpoint resides within private or loopback IP ranges:

- **Loopback**: `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `[::1]`
- **RFC 1918 Private IPv4**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- **Internal Domains**: `.local`, `.internal`, `.corp`, `.lan`, `.cluster.local`

---

## Environment Variables Reference

Configure local model inference across the web app, background workers, and CLI using the following environment variables:

### Generic Local AI Variables

| Variable                     | Description                                                                                                                     | Example / Default                |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------ | :------------------------------- |
| `LOCAL_AI_URL`               | Base URL of the OpenAI-compatible inference server. Auto-detects provider (`:11434` -> `ollama`, `:8000` -> `vllm`).            | `http://localhost:11434/v1`      |
| `LOCAL_AI_MODEL`             | Model tag or identifier to load for analysis.                                                                                   | `llama3`, `codellama`, `mistral` |
| `LOCAL_AI_PROVIDER`          | Explicit provider designation (`ollama`, `vllm`, or `custom`).                                                                  | `ollama`                         |
| `LOCAL_AI_API_KEY`           | Optional bearer token for authenticated on-prem cluster endpoints.                                                              | Defaults to `"local"`            |
| `LOCAL_AI_FALLBACK_MODELS`   | Comma-separated list of smaller fallback model tags to try in order when GPU memory is exhausted.                               | `llama3.2:3b,llama3.2:1b`        |
| `VRAM_CONCURRENCY_THRESHOLD` | Max concurrent local inference generations permitted per worker via `Semaphore` (`DEFAULT_LOCAL_VRAM_CONCURRENCY`).             | `1`                              |
| `LOCAL_AI_MAX_CONCURRENCY`   | High-priority concurrency alias (`LOCAL_AI_CONCURRENCY_LIMIT` also accepted before `VRAM_CONCURRENCY_THRESHOLD`).               | `1`                              |
| `LOCAL_AI_MAX_QUEUE_WAIT_MS` | Max semaphore queue wait duration in ms before failing over or throwing `VRAMConcurrencyError` (`DEFAULT_LOCAL_QUEUE_WAIT_MS`). | `30000`                          |

### Dedicated Ollama Variables

| Variable                         | Description                                                       |
| :------------------------------- | :---------------------------------------------------------------- |
| `OLLAMA_URL` / `OLLAMA_BASE_URL` | Explicit Ollama endpoint URL (e.g., `http://localhost:11434/v1`). |
| `OLLAMA_MODEL`                   | Explicit model tag for Ollama (e.g., `llama3`, `codellama:13b`).  |

### Dedicated vLLM Variables

| Variable                     | Description                                                                       |
| :--------------------------- | :-------------------------------------------------------------------------------- |
| `VLLM_URL` / `VLLM_BASE_URL` | Explicit vLLM endpoint URL (e.g., `http://localhost:8000/v1`).                    |
| `VLLM_MODEL`                 | Explicit model identifier for vLLM (e.g., `meta-llama/Meta-Llama-3-8B-Instruct`). |

---

## CLI Usage & Flags

The SecureFlow CLI (`secureflow`) provides dedicated CLI flags to invoke local inference:

```bash
# 1. Run local scan using default Ollama endpoint and model (llama3)
secureflow --local

# 2. Specify a custom local model tag
secureflow --local --local-model llama3.2:3b

# 3. Use an inline custom local URL
secureflow --local=http://10.0.0.50:11434/v1 --local-model codellama

# 4. Explicit Ollama flag with custom model
secureflow --ollama --ollama-model codellama:7b

# 5. Explicit vLLM flag with custom endpoint and model
secureflow --vllm=http://localhost:8000/v1 --vllm-model meta-llama/Meta-Llama-3-8B-Instruct

# 6. Completely disable AI scanning (heuristic pattern scan only)
secureflow --no-ai
```

---

## VRAM & Hardware Requirements

Running LLMs locally requires sufficient system RAM (CPU inference) or GPU VRAM (accelerated inference).

### General VRAM Sizing Guide

| Model Class            | Parameter Count                                   | Quantization         | Minimum Recommended VRAM | Suitable Hardware                                                   |
| :--------------------- | :------------------------------------------------ | :------------------- | :----------------------- | :------------------------------------------------------------------ |
| **Ultra-Light**        | 1B – 3B (e.g., `llama3.2:1b`, `llama3.2:3b`)      | 4-bit / 8-bit        | **2 GB – 4 GB**          | Apple Silicon M-series (base), NVIDIA GTX 1650/RTX 3050, or CPU RAM |
| **Standard**           | 7B – 8B (e.g., `llama3:8b`, `codellama:7b`)       | 4-bit (Q4_K_M)       | **6 GB – 8 GB**          | NVIDIA RTX 3060/4060 (8GB/12GB), Apple M1/M2/M3 (16GB RAM)          |
| **High Precision**     | 7B – 8B (e.g., `Meta-Llama-3-8B-Instruct`)        | 16-bit (FP16 / BF16) | **16 GB – 20 GB**        | NVIDIA RTX 4080 (16GB), RTX 3090/4090 (24GB), Apple Silicon 24GB+   |
| **Enterprise / Large** | 13B – 34B (e.g., `codellama:34b`, `mixtral:8x7b`) | 4-bit / 8-bit        | **24 GB – 48 GB**        | Dual RTX 3090/4090, NVIDIA A10G / A5000 / A100                      |

---

## Insufficient Memory & Fallback Handling (#1140)

If a local inference server runs out of GPU memory during a scan, SecureFlow catches the failure and prevents unhandled process crashes.

### Detected Out-of-Memory Patterns (`isInsufficientMemoryError`)

The system inspects server error messages for known out-of-memory indicators:

- **Ollama**: `"model requires more system memory (X GiB) than is available (Y GiB)"`
- **CUDA / llama.cpp**: `"CUDA error: out of memory"`, `"failed to allocate ... buffer"`, `"cudaMalloc failed"`
- **vLLM**: `"CUDA out of memory"`, `"No available memory for the cache blocks"`
- **General**: `"insufficient vram"`, `"insufficient gpu memory"`, `"OOM"`

### Fallback Sequence (`LOCAL_AI_FALLBACK_MODELS`) & Concurrency Budgets

1. Define a list of progressively smaller models in `LOCAL_AI_FALLBACK_MODELS`:
   ```bash
   LOCAL_AI_FALLBACK_MODELS=llama3.2:3b,llama3.2:1b
   ```
2. When the primary model fails due to insufficient memory (`isInsufficientMemoryError`) or local GPU queue saturation (`isVramConcurrencyError` / `VRAMConcurrencyError`), SecureFlow does **not** retry the same failing model — it immediately advances to each fallback model in order and never caches fallback answers under the primary model key.
3. If all models fail with out-of-memory errors, `InsufficientVRAMError` (`insufficientVramMessage`) is thrown/surfaced with a single-line actionable recommendation (no stack traces leaked):
   ```text
   Not enough GPU memory to load local model "llama3", "llama3.2:3b", "llama3.2:1b". Switch to a smaller model (for example LOCAL_AI_MODEL=llama3.2:3b) or list smaller ones in LOCAL_AI_FALLBACK_MODELS.
   ```
4. **Concurrency Budget Defaults**: Worker local inference defaults to `VRAM_CONCURRENCY_THRESHOLD=1` (`DEFAULT_LOCAL_VRAM_CONCURRENCY = 1`, resolved via `getLocalModelVramThreshold()` with precedence `LOCAL_AI_MAX_CONCURRENCY` → `LOCAL_AI_CONCURRENCY_LIMIT` → `VRAM_CONCURRENCY_THRESHOLD`) and `LOCAL_AI_MAX_QUEUE_WAIT_MS=30000` (`DEFAULT_LOCAL_QUEUE_WAIT_MS = 30000`, resolved via `getLocalQueueWaitMs()`). See [Local Inference & Worker HPA Architecture Guide](./helm-local-inference-vram-hpa.md) for Kubernetes GPU scheduling and HPA configuration.
5. **Air-Gap Invariant**: Local mode **never** falls back to cloud providers. All fallback attempts remain strictly bound to the configured local endpoint (`openai/<model>`).

---

## Health Checks & Connectivity Testing

### Via Programmatic API (`pingLocalModel`)

```ts
import { resolveLocalModelConfig, pingLocalModel } from "@/ai/local-model";

const config = resolveLocalModelConfig();
if (config) {
  const status = await pingLocalModel(config, 3000);
  console.log(status); // { ok: true, provider: "ollama" }
}
```

### Via `curl` (Ollama)

```bash
curl -s http://localhost:11434/v1/models | jq .
```

### Via `curl` (vLLM)

```bash
curl -s http://localhost:8000/v1/models | jq .
```
