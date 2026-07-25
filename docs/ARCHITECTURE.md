# SecureFlow Architecture Overview

Welcome to the SecureFlow architecture guide. This document provides a high-level overview of how the core components of SecureFlow interact within the Next.js App Router ecosystem. 

Our goal is to provide a scalable, responsive, and secure platform that integrates deeply with GitHub while leveraging modern AI reasoning capabilities.

---

## 1. Foundation: Next.js App Router
SecureFlow is built on top of the **Next.js App Router**. This modern React framework provides the backbone of the application:
- **Server Components (RSC)**: Used to fetch data securely from the database without shipping JavaScript to the client. This powers the Mission Control dashboard and Vault Logs.
- **Client Components**: Used for interactive UI elements (e.g., charts, dynamic form submissions, and real-time streaming interfaces).
- **Route Handlers**: Serve as our API endpoints, including the critical webhooks that listen to GitHub events.

## 2. Event-Driven Asynchronous Processing: Redis Queues
GitHub webhooks have strict timeout limits. When a Pull Request is opened or updated, the payload must be acknowledged immediately.
- **The Problem**: Running high-fidelity security scans (ArmorIQ Scanner) synchronously within an API route would cause timeouts.
- **The Solution**: We use **Redis** (via `ioredis` / `bullmq` or similar queueing mechanisms) to decouple event ingestion from processing.
- **Flow**:
  1. GitHub sends a webhook to our Next.js Route Handler.
  2. The handler immediately pushes the job onto a Redis queue and responds to GitHub with a `200 OK`.
  3. A background worker (or serverless queue consumer) picks up the job, runs the ArmorIQ Scanner, evaluates policies, and updates GitHub PR statuses.

## 3. Data Persistence: Prisma & PostgreSQL
SecureFlow requires a persistent audit trail and configuration state.
- **Prisma** acts as our type-safe ORM. It bridges our TypeScript codebase with our PostgreSQL database.
- **What we store**:
  - **Vault Logs**: The immutable audit trail of automated security decisions and actions.
  - **Findings**: Security vulnerabilities and hardcoded secrets identified by the scanner.
  - **Policies**: Customizable rules that map scanner findings to specific states (Pass, Review Required, Blocked).
- Prisma integrates seamlessly into Next.js Server Components and server-side API routes, ensuring data operations are fast and strictly typed.

## 4. AI Reasoning Engine: Genkit & Groq SDK
"The Professor" — SecureFlow's AI mastermind — relies on advanced language models to provide human-readable risk summaries and remediation advice.
- **Genkit**: Developed by Google, Genkit is the AI orchestration framework we use to define and run our AI workflows (Flows). It manages prompt execution, streaming, and tool calling in a structured, observable way.
- **Groq SDK**: We use Groq's blazing-fast inference API as the underlying model provider for Genkit. This ensures that when a user requests an explanation for a complex vulnerability, the response is generated and streamed back with near-zero latency.
- **Integration**:
  1. The user requests an explanation for a finding on the client.
  2. A Next.js API route invokes a Genkit Flow.
  3. Genkit structures the prompt (incorporating our "Professor" persona instructions) and calls the Groq SDK.
  4. The result is streamed back to the client in real-time, providing an immersive, high-speed decryption experience.

## Component Interaction Summary
1. **Ingestion**: Next.js App Router receives GitHub webhooks.
2. **Queuing**: Webhooks are offloaded to **Redis** for asynchronous processing.
3. **Execution**: The background worker scans the PR.
4. **Storage**: Scan results and audit trails are saved to PostgreSQL via **Prisma**.
5. **Reasoning**: When a user reviews a finding, **Genkit** orchestrates a prompt via the **Groq SDK** to stream AI-generated remediation advice back to the Next.js UI.
