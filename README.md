# AI.Prof Healthcare Access Platform

Autonomous multi-hospital patient intake, real-time voice scheduling, EHR synchronization, and pre-visit clinical routing platform.

---

## 1. Overview & Architectural Philosophy

**AI.Prof** is a production-grade multi-tenant healthcare access platform designed to streamline outpatient appointment booking, reduce front-desk call burden, and capture structured pre-visit clinical intake data before patient visits. The system coordinates across hospital networks, integrating directly with electronic health record (EHR/EMR) systems while enforcing strict clinical safety boundaries, row-level multi-tenant isolation, and resilient failure recovery.

### Key Capabilities
- **Autonomous AI Patient Access Agent**: Real-time conversational agent processing natural language patient queries over text chat, streaming WebSockets, and telephony.
- **10-Layer Clean Architecture**: Strict unidirectional layering from edge interfaces through AI context, concurrency-locked scheduling, healthcare connectors, post-write verification, and event workflows.
- **Clarification-Over-Guessing**: When requests are ambiguous (e.g. asking to book a doctor with multiple open slots), the agent queries real availability and requests clarification rather than making assumptions.
- **Inviolable Clinical Boundaries (PRD Section 20)**: Strictly administrative; automatically refuses clinical inquiries, diagnosis, and prescription advice, quoting patient words accurately and immediately transferring to licensed medical staff.
- **Atomic Concurrency Protection**: High-throughput slot reservation preventing double bookings across distributed intake channels.
- **Verification Before Confirmation**: Never confirms bookings to patients until externally verified in the downstream EHR system.
- **Automated Failure Recovery (PRD Section 28)**: Re-queries external state upon network timeouts (Unknown Outcome recovery) without duplicate booking creation, and creates human escalation records if retries exhaust.

---

## 2. Documentation Index

- [**System Architecture Specification**](docs/ARCHITECTURE.md): Complete 10-layer architectural topology, component boundaries, and security model.
- [**AI Agent Guide & Benchmarks**](docs/ai/README.md): AI Agent design, model choices, evaluation metrics, and capabilities breakdown.
- [**Real-Time Voice Architecture**](docs/ai/VOICE.md): Web Audio API, Gemini Live API streaming, latency/cost tradeoffs, and telephony integration.
- [**Reviewable System Prompt**](docs/ai/SYSTEM_PROMPT.md): Official PRD Section 20 system prompt loaded into the agent at runtime.
- [**Scene-by-Scene Demo Script**](docs/DEMO_SCRIPT.md): Step-by-step walkthrough covering all 13 required evaluation scenarios.
- [**Data Model Specification**](docs/data-model.md): Comprehensive database entity-relationship schema and audit models.

---

## 3. Tech Stack

| Layer | Technology | Justification |
| :--- | :--- | :--- |
| **Monorepo & Build** | Turborepo + pnpm workspaces | Fast caching, explicit dependency graphs, and clean package boundaries. |
| **Backend & API** | Node.js (v20/v22), Fastify, TypeScript | Sub-millisecond routing overhead, high-performance async I/O, native JSON schema validation, typed contracts. |
| **Database & ORM** | SQLite (zero-config dev) / PostgreSQL 16 (production), Prisma ORM | Complete relational integrity, ACID concurrency row-locking, and seamless environment portability. |
| **Real-Time AI & Voice** | Google Gemini 2.0 Flash, Gemini Live API, Fastify WebSocket | Bidirectional low-latency audio streaming, conversational dialogue state tracking, and native function calling. |
| **Frontend UI** | React 18, Vite, TailwindCSS | Instant HMR development, accessible design, and role-based portals (Platform Admin, Hospital Admin, Doctor, Patient). |
| **Queue & Workflows** | BullMQ + In-process async queue / Redis | Reliable delayed execution for questionnaires, multi-channel reminders, and state reconciliation sweeps. |
| **Observability** | Pino, AsyncLocalStorage, Custom Metrics Collector | Structured JSON logging with automatic PHI redaction regex filters, correlation ID tracing, and latency histograms. |

---

## 4. Seeded Demo Accounts & Credentials

The platform is pre-seeded with four primary operational roles across multi-hospital tenants. All accounts share the demo password: `Password123!`

| Role | Email | Password | Tenant / Hospital Scope | Dashboard URL |
| :--- | :--- | :--- | :--- | :--- |
| **Platform Admin** | `platform.admin@health.org` | `Password123!` | System-wide (All Hospitals) | `/dashboards/platform-admin` |
| **Hospital Admin** | `admin@apexhealth.org` | `Password123!` | Apex Regional Medical Center | `/dashboards/hospital-admin` |
| **Doctor** | `dr.rao@apexhealth.org` | `Password123!` | Dr. Arvind Rao (Orthopedics) | `/dashboards/doctor` |
| **Patient** | `jane.doe@example.com` | `Password123!` | Jane Doe | `/dashboards/patient` |

---

## 5. Environment Variables Guide

Copy `.env.example` to `.env`. The default settings enable zero-config local execution using embedded SQLite:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime environment (`development`, `production`, `test`). |
| `PORT` | `3001` | REST API Server port. |
| `VOICE_GATEWAY_PORT` | `3002` | Real-time WebSocket Voice Gateway port. |
| `MOCK_EHR_PORT` | `4000` | Out-of-process Mock EHR server port. |
| `DATABASE_URL` | `file:./dev.db` | Prisma SQLite connection URL (or `postgresql://user:pass@host:5432/db`). |
| `JWT_SECRET` | `super-secret-...` | Cryptographic secret for signing session tokens. |
| `GEMINI_API_KEY` | *(optional)* | Google Gemini API key for Live Voice streaming and conversational LLM turn generation. |
| `TWILIO_ACCOUNT_SID` | *(optional)* | Twilio Account SID for telephony inbound voice webhooks. |
| `TWILIO_AUTH_TOKEN` | *(optional)* | Twilio authentication token for webhook signature validation. |
| `TWILIO_PHONE_NUMBER`| *(optional)* | Dedicated PSTN intake phone number. |
| `MOCK_EHR_BASE_URL` | `http://localhost:4000` | Target endpoint for Mock EHR integration connector. |
| `CHAOS_MODE` | `false` | When `true`, enables fault injection (simulated latency, 500 errors, network drops). |
| `REDIS_URL` | `redis://localhost:6379` | *(Optional)* Redis server connection string for distributed BullMQ queue. |

---

## 6. Setup & Local Development

### 1. Prerequisites
- **Node.js**: v20+ or v22+
- **pnpm**: v9+ or v10+ (`npm install -g pnpm`)

### 2. Installation & Database Migration
```bash
# Clone the repository
git clone <repository-url>
cd AI_PROF_PROJECT

# Install all workspace dependencies
pnpm install

# Setup environment
cp .env.example .env

# Generate Prisma Client, run migrations, and seed test data
pnpm db:generate
pnpm db:push
pnpm db:seed
```

### 3. Start Development Services
Run all microservices concurrently via Turborepo:
```bash
pnpm dev
```

Or start individual components in dedicated terminals:
```bash
# Core REST API (Port 3001)
pnpm --filter @health/api-server dev

# Real-Time Voice Gateway (Port 3002)
pnpm --filter @health/voice-gateway dev

# Out-of-process Mock EHR Server (Port 4000)
pnpm --filter @health/mock-ehr dev

# Frontend React Application (Port 5173)
pnpm --filter @health/web dev
```

### 4. Health & Verification Endpoints
- **Web UI Portal**: [http://localhost:5173](http://localhost:5173)
- **API Health**: `GET http://localhost:3001/health`
- **Voice Gateway Health**: `GET http://localhost:3002/health`
- **Mock EHR Health**: `GET http://localhost:4000/health`
- **System Prompt Inspection**: `GET http://localhost:3001/api/chat/system-prompt`

---

## 7. Testing & Verification

The test suite validates the entire PRD matrix (176 tests across Unit, Integration, AI, and EHR categories):

```bash
# Run all unit tests (availability, state machine, capabilities, AI agent, locks)
npx tsx --test tests/unit/*.test.ts

# Run integration handoffs & multi-tenant isolation tests
npx tsx --test tests/integration/pipeline-stages.test.ts tests/integration/api-tenant-isolation.test.ts

# Run PRD Section 28 EHR failure recovery scenarios (A, B, C)
npx tsx --test tests/integration/failure-recovery.test.ts

# Run complete consolidated PRD suite
npx tsx --test tests/integration/prd-full-suite.test.ts
```

---

## 8. Known Limitations & Future Improvements

### Current Limitations
1. **PSTN Telephony Carrier Gateway**: The voice gateway supports bi-directional WebSockets via the browser Web Audio API and Twilio Media Stream protocols. In local demonstration mode without external telephony carrier routing, calls are tested via the browser Voice HUD or simulated audio frames.
2. **External SMS & Email Carrier Dispatch**: Notifications are persisted in the database with delivery state tracking and surfaced directly on role-scoped dashboards, rather than dispatching through third-party SMS shortcodes or SendGrid relays.
3. **Test Suite Execution Serialization (`--test-concurrency=1`)**: The automated test harness executes test suites sequentially (`--test-concurrency=1`) to prevent separate in-process integration test suites from simultaneously attempting to bind static port 4000 for the Mock EHR; this is purely a test-harness port allocation fix, not a statement about validated concurrent load against the Mock EHR itself.

### Future Roadmap
1. **Direct FHIR R4 Bundle Connectors**: Implement direct SMART on FHIR REST interfaces for Epic, Cerner, and AthenaHealth EHR environments.
2. **Real-Time Payer Eligibility (270/271 EDI Transactions)**: Query copay, deductible, and network coverage before slot reservation.
3. **Edge-Terminated WebSocket Voice Clusters**: Deploy regional voice gateways (US-East, US-West, EU-Central) to achieve sub-400ms global perceived latency.
