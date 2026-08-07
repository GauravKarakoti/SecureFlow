# **App Name**: SecureFlow

*"In this heist, we're not stealing — we're protecting." SecureFlow casts every Pull Request as a member of the crew trying to reach The Vault (your codebase), with **The Professor** — SecureFlow's AI mastermind — checking credentials at the door before any breach gets through.*

## Core Features:

- **GitHub App Integration — The Inside Job**: Streamlined GitHub OAuth flow for repository selection and automated pull request webhook listeners. This is how the crew gets access to the building in the first place.
- **ArmorIQ Scanner — The Professor's Eyes**: High-fidelity security scan implementation that identifies hardcoded secrets, vulnerable dependencies, and insecure code patterns during PR cycles.
- **AI Reasoner Tool — The Professor's Voice**: An AI tool that applies logical reasoning to scanner findings to provide human-readable risk summaries and direct remediation advice in plain English, in-character as "The Professor."
- **ArmorIQ Policy Engine — The Plan**: Logic engine for automated risk evaluation, mapping findings to customizable policy states: Pass, Review Required, or Blocked.
- **Mission Control Dashboard**: Centralized workspace featuring high-level risk trends, PR status visualizations, and active vulnerability metrics built with shadcn/ui and Recharts.
- **Vault Logs — Audit Transparency**: A persistent audit trail stored in PostgreSQL for all automated security decisions, actions, and scanner results.
- **PR Status Reporter — The Getaway Signal**: Automated commit status updates and granular inline GitHub comments with direct feedback and action buttons.

## Style Guidelines:

- **Primary Color**: Heist Red (`hsl(356 96% 47%)` ≈ `#EB0514`) — the signature red of the crew's jumpsuits, used for primary actions, alerts, and the accent color throughout the app.
- **Background Color**: Deep Cinematic Black (`hsl(0 0% 4%)` ≈ `#0A0A0A`) in dark mode — evoking the shadows of the vault. Light mode uses a crisp off-white (`hsl(0 0% 98%)`) for high-contrast daytime use.
- **Card/Surface Color**: Slightly raised black (`hsl(0 0% 7%)` ≈ `#121212`) to separate cards and panels from the background without breaking the dark aesthetic.
- **Font Pairing**: 'Roboto' (Sans-serif) for bold, cinematic headlines and 'Inter' (Sans-serif) for clean, highly-readable body text and UI controls.
- **Iconography**: Ultra-thin, mono-lineal strokes for icons, utilizing high-contrast borders to suggest precision and structural integrity — every line as deliberate as the heist itself.
- **Layout**: Spacious, container-less dashboard layout with high-blur background glass effects (Glassmorphism) to define hierarchy without visual clutter.
- **Motion**: Sophisticated micro-interactions using framer-motion, featuring rhythmic horizontal loaders that simulate continuous scanning pulses — The Professor, always watching.

## Narrative & Copy Guidelines:

Use these terms consistently across UI copy, docs, and marketing surfaces so the theme stays coherent app-wide:

| Theme Term | Refers To |
|---|---|
| The Professor | The AI security reasoner/persona behind explanations and remediation |
| The Vault | The codebase / protected repository |
| Mission Control | Main dashboard overview (`/dashboard`) |
| Breach Attempts | Security findings page (`/dashboard/findings`) |
| Defense Strategy | Policy management page (`/dashboard/policies`) |
| Vault Logs | Audit log page (`/dashboard/audit`) |
| The Resistance | SecureFlow's users/community defending their codebases |
| Bella Ciao | Tagline motif used for "all clear" / passed-audit moments |

Keep the tone confident and cinematic, never juvenile — SecureFlow is a serious security tool wearing a fun theme, not the other way around.