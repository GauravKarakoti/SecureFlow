import { defineConfig } from "vitepress";

export default defineConfig({
  title: "SecureFlow Docs",
  description: "Automated PR security scanning, secret detection, and defense in depth.",
  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  // Ignore links to source files outside the docs folder and local dev ports
  ignoreDeadLinks: [/^https?:\/\/localhost/, /^(\.\/)?\.\.\//, /^file:\/\//, /^mailto:/],
  markdown: {
    // Turn ```mermaid fences into <MermaidDiagram> (registered in ./theme) so they
    // render as diagrams instead of plain code blocks (#2178).
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        if (token.info.trim() === "mermaid") {
          return `<MermaidDiagram code="${encodeURIComponent(token.content)}" />\n`;
        }
        return fence(tokens, idx, options, env, self);
      };
    },
  },
  themeConfig: {
    siteTitle: "SecureFlow",
    logo: "/logo.png",
    search: {
      provider: "local",
      options: {
        detailedView: true,
      },
    },
    editLink: {
      pattern: "https://github.com/GauravKarakoti/SecureFlow/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    nav: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/setup" },
      { text: "Architecture", link: "/architecture" },
      { text: "Security", link: "/security/rate-limiting" },
      { text: "Operations", link: "/runbook" },
      { text: "API", link: "/api" },
      {
        text: "v0.1.0",
        items: [
          { text: "Changelog", link: "https://github.com/GauravKarakoti/SecureFlow/releases" },
          { text: "GitHub Repository", link: "https://github.com/GauravKarakoti/SecureFlow" },
          {
            text: "API Client (npm)",
            link: "https://www.npmjs.com/package/@secureflow/api-client",
          },
          {
            text: "GitHub Action (Marketplace)",
            link: "https://github.com/marketplace/actions/secureflow-security-scan",
          },
        ],
      },
    ],
    sidebar: [
      {
        text: "Getting Started",
        collapsed: false,
        items: [
          { text: "Local Setup Guide", link: "/setup" },
          { text: "Deployment & Egress Hardening", link: "/deployment" },
          { text: "Safe Upgrade Guide", link: "/upgrade" },
          { text: "Database Backup & Restore", link: "/database-backup-restore" },
          { text: "QNX SDP 8.0 Toolchain", link: "/qnx-toolchain" },
        ],
      },
      {
        text: "Architecture & Design",
        collapsed: false,
        items: [
          { text: "Architecture & Contributor Guide", link: "/architecture" },
          { text: "System Blueprint", link: "/blueprint" },
          { text: "Threat Model & STRIDE Analysis", link: "/threat-model" },
          { text: "CODEOWNERS & Ownership", link: "/codeowners-ownership" },
          { text: "Data Retention Policy", link: "/data-retention" },
          { text: "Status Badge", link: "/status-badge" },
        ],
      },
      {
        text: "Security & Hardening",
        collapsed: false,
        items: [
          { text: "API Rate Limiting", link: "/security/rate-limiting" },
          { text: "Dependency Vulnerability Triage", link: "/security/dependency-triage" },
          { text: "Finding Encryption at Rest", link: "/security/finding-encryption" },
          { text: "Prompt Injection Defense", link: "/security/prompt-injection" },
          { text: "HTTP Response Headers", link: "/security/response-headers" },
          { text: "Outbound Webhook Dispatch", link: "/security/outbound-webhooks" },
        ],
      },
      {
        text: "Policies & Gates",
        collapsed: false,
        items: [
          { text: "Configurable PR Gate (.secureflow.json)", link: "/gate-configuration" },
          { text: "Blocking Merges on Critical Findings", link: "/block-merge-on-critical" },
          { text: "Policy Export and Import Format", link: "/policy-export-import" },
        ],
      },
      {
        text: "Inference & Performance",
        collapsed: false,
        items: [
          { text: "Local Model & VRAM Configuration", link: "/local-inference" },
          { text: "Local Inference & Worker HPA", link: "/helm-local-inference-vram-hpa" },
          { text: "Finding Query Performance", link: "/finding-query-performance" },
          { text: "Webhook Load Testing & Benchmarks", link: "/load-testing" },
        ],
      },
      {
        text: "Operations & Observability",
        collapsed: false,
        items: [
          { text: "Operations Runbook", link: "/runbook" },
          { text: "Logging & Metrics Observability", link: "/observability" },
          { text: "Threat Intelligence MCP Server", link: "/mcp-server" },
        ],
      },
      {
        text: "API Reference",
        collapsed: false,
        items: [{ text: "REST API Overview", link: "/api" }],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/GauravKarakoti/SecureFlow" }],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 SecureFlow Team",
    },
  },
});
