<div align="center">

# ⚡ HireAlpha

**Autonomous AI hires that live inside your iMessage, SMS, WhatsApp, and Slack.**  
*Software disguised as conversation.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3-FBF0DF?style=for-the-badge&logo=bun&logoColor=black)](https://bun.sh/)
[![React 19](https://img.shields.io/badge/React-19.0-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Stripe](https://img.shields.io/badge/Stripe-Link-635BFF?style=for-the-badge&logo=stripe&logoColor=white)](https://stripe.com/)
[![Playwright](https://img.shields.io/badge/Playwright-Browser_Automation-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev/)

<br/>

[Live Product](https://hirealpha.chat) • [The 3 Hires](#the-three-hires) • [Mini-App Engine](#in-thread-mini-apps) • [Link Agentic Purchases](#autonomous-purchases-with-link) • [Architecture](#architecture) • [Quick Start](#quick-start) • [Deployment](#deployment)

<br/>

</div>

---

## 💡 What is HireAlpha?

Most AI assistants are chatbots trapped in a browser tab that vomit walls of Markdown prose.

**HireAlpha is an autonomous workforce that texts you first.**  
Each hire is a distinct, persistent contact with its own phone number, memory, personality, and toolchain. When work needs doing, they don't hallucinate or lecture you — **they mint interactive, reactive micro-applications directly inside your conversation thread.**

```
YOU (iMessage) ──────────────────────> "I ate a chipotle chicken bowl with guac and a diet coke"
                                     
ALPHA (Friend) <────────────────────── "Logged 820 cal · 54g protein. You have 420 cal left today."
                                       [ Interactive Nutrition Breakdown & Deficit Ring ↗ ]

YOU (iMessage) ──────────────────────> "Schedule 30m with Sarah next week"
                                     
ALPHA (Coworker) <──────────────────── "Found 3 slots across your Google Calendar. Sent her a link:"
                                       [ Pick-A-Slot Scheduling Sheet ↗ ]
```

---

## 👔 The Three Hires

HireAlpha is **not one chatbot with toggleable modes**. It is three dedicated hires with strict memory partitions — your personal assistant never sees your sales pipeline, and your cofounder never asks about your protein goal.

| Hire | Persona & Role | In Messages As | Live Surface | Core Superpowers |
| :--- | :--- | :--- | :--- | :--- |
| **Friend** | **Personal Chief of Staff**<br/>Health, habits, finances, relationships | `Alpha`<br/>*(415) 595-1440* | **Live Now** | • Morning & Evening Debriefs (`The Day, Closed`)<br/>• Vision Nutrition Guessing (Gemini 3.7 Flash)<br/>• 5-Day Workout Splits with Animated GIF Demos<br/>• Emoji-Free Glassmorphic Mood Tracker<br/>• Relationship Radar ("Who is due a ping") |
| **Coworker** | **Executive Colleague**<br/>Linear, GitHub, inbox zero, standups | `Alpha (Coworker)` | *Workshop Rollout* | • Linear Issue Triage & GitHub PR Digests<br/>• Attendee dossiers & 1-tap pre-meeting briefs<br/>• Standup synthesis & automated drafting<br/>• Email review ("Approve & Send" card)<br/>• Open loops & task commitments ledger |
| **Cofounder** | **Startup Partner**<br/>Pipeline, runway, investor updates | `Alpha(CoFounder)` | *Workshop Rollout* | • Live Deal CRM & Pipeline Stage Board<br/>• Runway snapshots, monthly burn & cash forecasting<br/>• Decision Ledger with historical outcome tracking<br/>• Investor update drafting & shareholder letters |

---

## 📱 In-Thread Mini-Apps

When an action requires precision, Alpha sends a high-speed, cryptographically signed micro-application that opens instantaneously inside Messages or your browser.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        HIREALPHA MINI-APP ECOSYSTEM                    │
├───────────────────┬───────────────────────────────┬────────────────────┤
│ 🏃 Life & Fitness │ 💼 Executive & Work           │ 🚀 Startup & Fund  │
├───────────────────┼───────────────────────────────┼────────────────────┤
│ • workout_log     │ • digest (Meeting Briefings)  │ • pipeline_board   │
│ • nutrition       │ • approve_send (Email Triage) │ • decision_ledger  │
│ • mood_tracker    │ • pick_slot (Calendar Booker) │ • runway_snapshot  │
│ • habit_streak    │ • linear_triage               │ • investor_update  │
│ • sleep_tracker   │ • standup_paste               │ • cap_table        │
│ • spending_radar  │ • open_loops                  │ • hire_decision    │
│ • networking_crm  │ • drop_zone                   │ • spiral_options   │
└───────────────────┴───────────────────────────────┴────────────────────┘
```

### 🏋️ Coach-Crafted Workout Engine (`workout_log`)
- **Dual Modality**: Toggle between bodyweight **Home** routines (zero gear required) and progressive overload **Gym** programs.
- **5 Focused Disciplines**: Strength & Muscle, Calisthenics, HIIT & Burn, Legs & Glutes, Core & Posture.
- **Form Demos**: Embedded, self-hosted animated demonstration GIFs for every single programmed movement with pacing cues.
- **Rest Interval Timers**: Auto-calculating countdown clocks for supersets, dropsets, and rest periods.

### 🥗 Multimodal Vision Nutritionist (`nutrition`)
- **Snap & Log**: Send a meal photo or raw text description over iMessage.
- **Gemini 3.7 Vision**: Multimodal estimation of calories, protein, carbs, and fats with formula reconciliation.
- **Live Daily Budget**: Tracks remaining calories against your target goal with persistent streak calculations.

### 🌙 Nightly Scorecard (`The Day, Closed`)
- **0–100 Algorithm**: Synthesizes workout logs, macro adherence, completed habits, and sleep quality into an objective daily performance score.
- **1-Tap Fix Shortcuts**: Any incomplete goal links directly to its interactive mini-app to log and boost your score before midnight.

---

## 🛡️ Autonomous Purchases with Link

HireAlpha features a safe autonomous commerce architecture. Alpha can browse, select items, and complete purchases on your behalf using **Stripe Link** and an isolated headless Playwright browser.

```mermaid
sequenceDiagram
  autonumber
  actor User as User (iMessage / Web)
  participant Alpha as Spectrum Agent
  participant API as hire-api
  participant Vault as Encrypted Vault
  participant Worker as Browser Worker (Playwright)
  participant Merchant as E-Commerce Merchant

  User->>Alpha: "Order the standard Whey Protein from Amazon"
  Alpha->>API: Propose purchase (item, merchant, estimated cost)
  API->>User: Renders [Approve Purchase Card] (Exact merchant + cap)
  User->>API: Taps "Approve $42.50"
  API->>Vault: Validate signed session & decrypt Link auth token
  API->>Worker: Dispatch isolated job with Link authorization
  Worker->>Merchant: Automate checkout in headless session
  Worker->>Vault: Retrieve single-use ephemeral virtual card
  Worker->>Merchant: Submit payment & capture confirmation
  Worker->>API: Return receipt & order ID
  API->>User: "Ordered! Tracking: #1Z999... Arriving Thursday."
```

- **Zero Card Leakage**: Raw card details never touch model prompts, disk logs, or database records.
- **Strict Spending Caps**: Per-purchase ceilings (`USER_SPEND_MAX_CENTS`, default $200) enforce strict spend boundaries.
- **Explicit Human-in-the-Loop**: Alpha **never** completes a transaction without a signed user tap on an approval card.

---

## 🏗️ Architecture

```mermaid
flowchart TB
  subgraph Ingestion["1. Multi-Channel Ingestion"]
    direction LR
    IM[iMessage / SMS]
    SL[Slack]
    WA[WhatsApp]
    WB[Web App · hirealpha.chat]
  end

  subgraph Engine["2. Turn Engine (Bun Spectrum)"]
    direction TB
    ROUTER[Intent Classifier]
    HONESTY[Honesty Guard & Ground Truth Filter]
    TOOLS[Tool Orchestrator · GMI / Gemini 3.7]
  end

  subgraph Core["3. Backend API (hire-api · Bun)"]
    direction TB
    AUTH[Session & Token Auth]
    MINI[Mini-App Card Minting]
    LOOP[Habit, Sleep & Loop Ledgers]
    BILL[Stripe Subscriptions]
  end

  subgraph Storage["4. Data & External Services"]
    direction LR
    PG[(Postgres 16)]
    COMP[Composio · Gmail & Calendar]
    PW[Playwright Browser Cluster]
    VAULT[Link Encrypted Secret Vault]
  end

  IM & SL & WA --> ROUTER
  WB --> AUTH
  ROUTER --> HONESTY --> TOOLS
  TOOLS --> Core
  Core --> PG
  Core --> COMP
  Core --> PW
  Core --> VAULT
  Core --> BILL
```

### The Engineering Invariant: The Honesty Guard
Unlike typical wrappers that hallucinate capabilities, HireAlpha enforces the **Honesty Guard**:
1. **Never Fakes Outbound Action**: Alpha will never claim it sent an email, text, or invitation unless the API returns an explicit provider ID.
2. **Never Invents Availability**: Meeting slots are derived directly from active free/busy Google Calendar blocks.
3. **Transparent Estimates**: Nutrition estimation explicitly flags itself as an AI estimate with easy manual adjustment.

---

## 📂 Repository Map

```text
HireAlpha/
├── src/                        # Frontend Single Page App (React 19 + TypeScript)
│   ├── platform/               # Logged-in application shell & 30+ interactive mini-apps
│   │   ├── BriefApp.tsx        # Morning & Evening Brief ("The Day, Closed")
│   │   ├── FeatureMiniApps.tsx # Nutrition, Mood, Habits, & Spending mini-apps
│   │   ├── LifeMiniApps.tsx    # Workout App (Interactive gym/home timer + GIFs)
│   │   ├── workoutProgram.ts   # Periodized workout matrices, categories, & splits
│   │   ├── exerciseDemos.ts    # Self-hosted exercise GIF animation map
│   │   ├── miniAppCatalog.ts   # Canonical slug aliases, icons, & routing matrix
│   │   └── homeA.css           # Ambient dark-mode glassmorphic design system
│   ├── Landing.tsx             # Marketing site with interactive phone simulator
│   └── index.css               # Global typography, tokens, & responsive layout
│
├── spectrum/                   # Autonomous Agent Bots (Bun runtime)
│   ├── alpha/                  # Alpha Friend persona (Chief of Staff)
│   ├── alpha-coworker/         # Alpha Coworker persona (Linear, Standup, Mail)
│   ├── alpha-cofounder/        # Alpha Cofounder persona (Pipeline, Runway)
│   └── shared/                 # Shared turn engine, tool dispatch, & honesty guards
│
├── deploy/                     # Backend Microservices & API
│   ├── hire-api.ts             # Core API: ~160 routes (auth, billing, briefs, DB)
│   ├── web-server.ts           # Production static server with Brotli & preload hints
│   ├── browserWorker.ts        # Isolated Playwright runner for Link autonomous purchases
│   ├── browserVault.ts         # AES-GCM encrypted user credential vault
│   └── gmailHelpers.ts         # Triage heuristics, timezone windows, & Composio bridges
│
├── services/                   # Autonomous execution tools (Playwright, Code sandbox)
├── scripts/                    # Deploy automation, database migrations, dev runners
└── marketing/                  # Launch assets, verified fact sheets, & promo videos
```

---

## 🚀 Quick Start

### Prerequisites
- [Bun](https://bun.sh/) (v1.2+)
- [Node.js](https://nodejs.org/) (v20+)
- [PostgreSQL](https://www.postgresql.org/) (v15+)

### 1. Clone & Install
```bash
git clone https://github.com/Sashank-Singh/hirealpha.git
cd hirealpha
npm install
```

### 2. Environment Setup
```bash
cp .env.example .env
```
Fill in the essential variables:
```env
DATABASE_URL="postgres://postgres:password@localhost:5432/hirealpha"
HIREALPHA_INTERNAL_KEY="your-internal-secret"
GMI_API_KEY="your-gemini-or-gmi-api-key"
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
```

### 3. Launch Development Servers

Run the backend API:
```bash
bun deploy/hire-api.ts
```

In a second terminal, launch the agent bots:
```bash
bash scripts/start-spectrum.sh
```

In a third terminal, run the Vite dev server:
```bash
npm run dev
```
Open **http://localhost:5173** to view the app!

---

## 🧪 Testing & Quality Assurance

HireAlpha maintains a comprehensive test suite covering turn gating, financial calculations, nutrition estimates, and timezone boundary conditions.

```bash
# Run all unit and integration tests (Bun test runner)
bun test

# Run specific domain suites
bun test spectrum/shared/workoutProgram.test.ts
bun test deploy/hireApiRoute.test.ts
bun test deploy/modelJson.test.ts

# Typecheck and lint
bun x tsc --noEmit
npm run lint
```

---

## 🚢 Production Deployment

Production is deployed on [Coolify](https://coolify.io/) with isolated container boundaries:

- **Unified Docker Image**: `Dockerfile` builds all three agent personalities from one optimized multi-stage build (`HIREALPHA_BOT=friend|coworker|cofounder`).
- **Nginx Reverse Proxy**: Production edge router (`deploy/nginx-web.conf`) with SSL termination, HTTP/2, and security headers.
- **Automated Zero-Downtime Deploy**:
  ```bash
  bash scripts/deploy-prod.sh
  ```
- **Self-Hosted Analytics**: Privacy-first Plausible instance (`deploy/plausible/`) tracking conversions and referral milestones.

---

## 📄 License & Integrity

Proprietary Software. Developed with precision by the HireAlpha core engineering team.  
For business inquiries, enterprise integrations, or custom deployments, visit [hirealpha.chat](https://hirealpha.chat).
