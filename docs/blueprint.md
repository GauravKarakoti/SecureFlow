# **App Name**: SecureFlow

## Core Features:

- GitHub App Integration: Streamlined GitHub OAuth flow for repository selection and automated pull request webhook listeners.
- ArmorIQ Scanner: High-fidelity security scan implementation that identifies hardcoded secrets, vulnerable dependencies, and insecure code patterns during PR cycles.
- AI Reasoner Tool: An AI tool that applies logical reasoning to scanner findings to provide human-readable risk summaries and direct remediation advice in plain English.
- ArmorIQ Policy Engine: Logic engine for automated risk evaluation, mapping findings to customizable policy states: Pass, Review Required, or Blocked.
- Executive Security Dashboard: Centralized workspace featuring high-level risk trends, PR status visualizations, and active vulnerability metrics built with shadcn/ui and Recharts.
- Audit Transparency Logs: A persistent audit trail stored in PostgreSQL for all automated security decisions, actions, and scanner results.
- PR Status Reporter: Automated commit status updates and granular inline GitHub comments with direct feedback and action buttons.

## Style Guidelines:

- Primary Color: Vibrant Deep Violet (#927BFF), providing a futuristic and high-tech feel that contrasts against deep surfaces.
- Background Color: Deep Graphite Charcoal (#0C0B0F), a desaturated variation of the primary hue to create an immersive, distraction-free dark interface.
- Accent Color: Electric Azure (#4D7BFF), an analogous hue that provides strong functional contrast for success states and interactive call-to-actions.
- Font Pairing: 'Space Grotesk' (Sans-serif) for sharp, technical-feeling headlines and 'Inter' (Sans-serif) for clean, highly-readable UI controls and density-rich scan results.
- Ultra-thin, mono-lineal strokes for icons, utilizing high-contrast borders to suggest precision and structural integrity.
- Spacious, container-less dashboard layout with high-blur background glass effects (Glassmorphism) to define hierarchy without visual clutter.
- Sophisticated micro-interactions using framer-motion, featuring rhythmic horizontal loaders that simulate continuous scanning pulses.