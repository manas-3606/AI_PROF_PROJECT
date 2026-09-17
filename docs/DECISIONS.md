# Architectural Decision Records (ADRs)

> **Document Version:** 1.0.0  
> **Repository:** Autonomous Multi-Hospital Patient Intake & Scheduling Platform  
> **Source Document:** [Product Requirements Document (PRD v2.0)](file:///docs/PRD.pdf)

---

## ADR-001: Unified TypeScript Monorepo (Node.js + Fastify + React)

- **Context:** The platform requires seamless end-to-end integration between the web frontend (4 dashboards + real-time voice HUD), an event-driven backend API, 17 AI capabilities with strict schemas, asynchronous workflow workers, and shared database domain models.
- **Decision:** Use a TypeScript Turborepo monorepo with Fastify for the backend API server and React + Vite for the frontend.
- **Rationale:**
  - Enables 100% type sharing across packages (`@health/shared-types`, `@health/db`, `@health/capabilities`), ensuring that capability contracts and domain entities never go out of sync.
  - Fastify delivers ultra-low latency, instant cold starts, native schema validation via TypeBox/Zod, and first-class WebSocket support.
  - Avoids context-switching between Python and TypeScript, optimizing engineering velocity for a 3–4 day prototype.
- **Consequences:** All developers work in a single language ecosystem. Native C++ or Python AI tooling is not needed because Gemini Live API provides first-class TypeScript SDKs (`@google/genai`).

---

## ADR-002: Concurrency & Double-Booking Prevention via PostgreSQL Row-Level Locking

- **Context:** PRD Section 7 explicitly mandates: *"The system must also prevent concurrent double booking through appropriate transactions, locking, reservation, or conflict-detection mechanisms... Availability should be revalidated immediately before booking when required."*
- **Decision:** Utilize PostgreSQL ACID transactions with `SELECT ... FOR UPDATE` row locks on doctor calendar slots at the time of booking creation.
- **Rationale:**
  - Distributed Redis locks can suffer from split-brain scenarios, clock drift, and orphaned leases if a worker crashes before unlocking.
  - PostgreSQL row-level locking couples the reservation lock directly to the transaction that creates the internal appointment record. If two concurrent patients (or voice turns) attempt to book the same slot at the exact same millisecond, the second transaction is blocked until the first commits, at which point the slot is detected as already booked, and a clean conflict error is returned.
- **Consequences:** Requires PostgreSQL as the single source of truth for slot reservations. Very high concurrency is easily handled within standard database connection pools.

---

## ADR-003: Self-Contained JWT Session Auth with Tenant-Scoped RBAC

- **Context:** PRD Section 4 and Section 21 specify 4 distinct roles (Platform Admin, Hospital Admin, Doctor, Patient) and strict multi-tenant isolation (*"Hospital A must never access Hospital B's private data"*). External OAuth providers (e.g., Auth0, Clerk) require external cloud configuration, redirect URIs, internet egress, and complex mock bypasses for automated test suites.
- **Decision:** Implement a self-contained, stateless JWT authentication service backed by `jose` and `bcrypt` with pre-seeded demo accounts for each role.
- **Rationale:**
  - Maximizes prototype setup speed and eliminates external credential dependencies.
  - JWTs carry cryptographically signed claims: `userId`, `role`, and `tenantId` (for hospital administrators and doctors).
  - Fastify authentication hooks inspect the token and inject a `tenantContext` into every request. Database query wrappers automatically append `WHERE tenant_id = request.tenantId`, enforcing tenant isolation at the boundary.
- **Consequences:** Password resets and email verification flows are simplified in the prototype. Production deployment would swap the token issuer with an enterprise identity provider without altering downstream application logic.

---

## ADR-004: Direct WebSocket Duplex Audio Streaming with Google Gemini Multimodal Live API

- **Context:** PRD Section 10 and 11 require real-time voice streaming with sub-2-second perceived latency, turn-taking, barge-in / interruption handling, and execution of controlled capabilities.
- **Decision:** Stream raw 16kHz PCM audio bidirectionally over WebSockets from the browser's Web Audio API directly to a Node.js voice session gateway connected to Google Gemini's Live API (`@google/genai`).
- **Rationale:**
  - Chaining separate STT (Speech-to-Text) -> LLM -> TTS (Text-to-Speech) pipelines introduces 2.5–4.5 seconds of round-trip latency, failing the sub-2s latency target.
  - Gemini's Multimodal Live API natively ingests audio frames, produces streaming audio tokens, handles voice activity detection (VAD) and interruption automatically, and emits structured function-call events when capabilities need to be invoked.
- **Consequences:** Requires persistent WebSocket connections. Handled cleanly via the dedicated `apps/voice-gateway` service.

---

## ADR-005: BullMQ with Redis for Workflows, Reminders & Retries

- **Context:** PRD Section 16 & 17 mandate asynchronous and scheduled workflows (delayed pre-visit questionnaires, appointment reminders, reconciliation sweeps, and retry mechanisms) with idempotency and failure states.
- **Decision:** Implement BullMQ backed by a local/Docker Redis instance.
- **Rationale:**
  - Heavyweight workflow engines like Temporal or Airflow introduce significant infrastructure overhead and steep learning curves for a 3–4 day prototype.
  - `cron` scripts in application memory are lost on server restart.
  - BullMQ provides persistent job storage, delayed scheduling (`delay: 24 * 3600 * 1000`), automatic exponential backoff retries with jitter, job deduplication via `jobId: idempotencyKey`, and Dead Letter Queues (DLQs) for unrecoverable errors.
- **Consequences:** Adds Redis to the local development environment (readily orchestrated via `docker-compose.yml`).

---

## ADR-006: Proactive Query-Based Resolution for Unknown Outcomes (PRD Option B & C)

- **Context:** PRD Section 13 and Section 28 require explicit failure demonstration for network timeouts and unknown outcomes: *"The system must not blindly retry operations that could create duplicate appointments."*
- **Decision:** Implement a two-phase verification and state machine for appointment booking. If an external EHR call times out or returns an ambiguous network error, the system classifies it as `UNKNOWN_OUTCOME`. The recovery worker executes a query (`GET /appointments?search=...`) to determine if the EHR created the appointment before failing.
- **Rationale:**
  - Blindly repeating a mutating `POST` request upon timeout can create duplicate appointments in hospital EHRs, resulting in double-booked clinic slots.
  - If the query reveals the appointment exists: The internal state synchronizes to `Confirmed` and maps the external ID.
  - If the query confirms it does not exist: The system safely performs an idempotent retry.
  - If retries exhaust: The state moves to `Reconciliation Required`, an alert is published to the admin dashboard, and `transfer_to_human` is initiated.
- **Consequences:** The appointment lifecycle includes explicit intermediate states (`Pending`, `Synchronization Pending`, `Reconciliation Required`) rather than simple binary success/fail.

---

## ADR-007: Stateful Mock EHR with Chaos / Fault Injection

- **Context:** PRD Section 12 & 28 mandate a Mock Healthcare System / EHR that hides vendor details and demonstrates realistic failure and recovery scenarios.
- **Decision:** Deploy a standalone Fastify service (`apps/mock-ehr`) that maintains an in-memory or isolated database of external patients, providers, and appointments, paired with an interactive Chaos API (`POST /chaos/configure`).
- **Rationale:**
  - Running a standalone mock service simulates genuine network boundaries and latency rather than mocking in-process code.
  - The Chaos API allows the test runner or evaluator to dynamically toggle:
    - `simulatedLatencyMs` (e.g., 5000ms to trigger client timeouts)
    - `failureMode: 'TIMEOUT' | '500_ERROR' | 'PHANTOM_CREATION'` (creates record but drops response socket)
  - Proves the resilience of the Verification and Synchronization layer in live demos.
- **Consequences:** The mock service runs as an independent process on port 4000, orchestrated via Turborepo and Docker Compose.

---

## ADR-008: Multi-Tenancy Architecture via Row-Level Scoping

- **Context:** PRD Section 3 & 21 state: *"Tenant isolation: One hospital must never access another hospital's private data."*
- **Decision:** Use a shared PostgreSQL database with mandatory `tenant_id` (foreign key to `Hospital`) on all tenant-specific tables (`Doctor`, `Calendar`, `Slot`, `Appointment`, `Questionnaire`, `AuditEvent`), enforced by Prisma query middleware.
- **Rationale:**
  - Database-per-tenant or schema-per-tenant adds severe migration and connection pooling overhead for a 3–4 day prototype.
  - Row-level scoping combined with automated ORM middleware provides ironclad isolation while allowing platform-level cross-tenant analytics for Platform Admins.
- **Consequences:** All tenant queries must include `tenantId`. Unit tests verify that hospital admin requests for other tenants are rejected with HTTP 403 Forbidden.

---

## ADR-009: Privacy-Aware Logging & PHI Redaction

- **Context:** PRD Section 3 & 20 state: *"Healthcare information should not unnecessarily appear in logs or AI context."*
- **Decision:** Implement a centralized logging wrapper (`packages/observability`) using Pino with an automated redact filter that masks sensitive fields (date of birth, phone number, symptoms, questionnaire answers).
- **Rationale:**
  - Guarantees compliance with healthcare privacy principles.
  - Traces system actions via anonymous `correlationId` and `operationId` without leaking patient identifiers into logs or metrics.
- **Consequences:** Developers must route all log statements through the `@health/observability` logger rather than `console.log`.

---

## ADR-010: Zero-Config Local Execution with PostgreSQL & Redis Support

- **Context:** Local evaluation environments may lack Docker or running PostgreSQL/Redis daemons. Requiring external services for initial evaluation creates onboarding friction.
- **Decision:** Architect `@health/db` and `@health/workflows` to support zero-config embedded fallbacks (SQLite for Prisma and an in-memory Redis adapter for BullMQ) while seamlessly connecting to full PostgreSQL and Redis whenever `DATABASE_URL` and `REDIS_URL` are configured in `.env`.
- **Rationale:**
  - Evaluators can clone the repo and run `pnpm install && pnpm dev` immediately without needing to install Docker Desktop, WSL2, or external daemons on Windows.
  - The exact same Prisma schema, domain models, and ACID transactions apply across environments.
- **Consequences:** Both local file-based testing and production PostgreSQL/Redis deployments are fully supported without code changes.

---

## ADR-011: Strict Alignment to PRD Section 10 Capabilities & Encapsulation of Slot Holds

- **Context:** PRD Section 10 explicitly enumerates exactly 17 capabilities: `search_hospitals`, `search_doctors`, `check_availability`, `lookup_patient`, `get_appointment`, `create_appointment`, `reschedule_appointment`, `cancel_appointment`, `get_questionnaire`, `submit_questionnaire`, `send_notification`, `start_workflow`, `get_context`, `update_preferences`, `verify_external_appointment`, `synchronize_state`, `transfer_to_human`. Extra conceptual actions (`get_hospital_details`, `check_insurance_accepted`, `estimate_consultation_fee`, `reserve_slot_hold`, `release_slot_hold`) create scope bloat violating Section 31 boundaries.
- **Decision:** 
  1. Remove extra standalone capabilities from the public AI Capability Registry and strictly expose the exact 17 PRD Section 10 capabilities.
  2. Encapsulate slot holding and concurrency locking directly inside `create_appointment` via `SchedulingService.bookAppointment` and `ConcurrencyLockManager`. When `create_appointment` runs, it acquires an atomic exclusive lock on the slot ID before making the external EHR call, eliminating the need for multi-step AI holding calls that risk dangling locks.
  3. Fully expose `verify_external_appointment`, `synchronize_state`, `start_workflow`, `update_preferences`, and `send_notification` as AI-callable capabilities in `CapabilityRegistry` so the conversational agent can directly invoke them (e.g., answering "did my booking go through?").
- **Rationale:**
  - Maintains 100% fidelity to PRD Section 10 and Section 31 scope boundaries.
  - Improves reliability by making slot reservation and EHR booking an atomic transaction rather than relying on the LLM to remember to release holds if a conversation drops.
- **Consequences:** All AI tool calling contracts, schemas, and documentation are strictly bounded to the exact 17 capabilities.

---

## ADR-012: Entity Mapping: Hospital Admin/Staff to Unified User Model with Role Enum

- **Context:** PRD Section 22 lists *"Hospital Admin/Staff"* as an entity, alongside *"Hospital"*, *"Doctor"*, and *"Patient"*.
- **Decision:** Implement Hospital Admin and Hospital Staff within the unified `User` model (`packages/db/prisma/schema.prisma`) using the `UserRole` enum (`HOSPITAL_ADMIN`, `HOSPITAL_STAFF`) and a tenant foreign key `hospitalId` (indexed and referencing `Hospital(id)` with cascade delete), rather than creating isolated `HospitalAdmin` and `HospitalStaff` database tables.
- **Reasoning:**
  1. **Unified Authentication & Security Pipeline:** All platform actors (Platform Admin, Hospital Admin, Hospital Staff, Doctor, Patient) share identical auth mechanisms: email/password hashing (`bcrypt`), JWT session issuance, audit event linking, and RBAC middleware enforcement. Fragmenting actors into disjoint tables would duplicate authentication logic, token verification, and password management.
  2. **DB-Level Tenant Scoping & Isolation:** For hospital-scoped roles (`HOSPITAL_ADMIN`, `HOSPITAL_STAFF`, `DOCTOR`), the `hospitalId` column carries an explicit database foreign key and `@@index([hospitalId])`. This guarantees database-level tenant isolation (preventing an admin of Hospital A from querying or mutating Hospital B assets) while allowing Platform Admins to retain `hospitalId = null`.
  3. **Role Transitions & Persona Extensions:** Users can transition roles (e.g., staff promoted to administrator) without cross-table schema migrations. Actors requiring distinct clinical or clinical-intake profiles extend `User` via 1:1 relations (`Doctor`, `Patient`).
- **Consequences:** Queries for staff/admins filter by `role: HOSPITAL_ADMIN` or `role: HOSPITAL_STAFF` within the tenant context (`hospitalId`).

---

## ADR-013: Entity Mapping: Availability to WorkingHour + BlockedSlot + Slot Decomposition

- **Context:** PRD Section 22 lists *"Availability"* as a core entity, while PRD Section 7, 8, and 14 demand recurring weekly shifts, doctor leaves/blackouts, appointment duration buffers, atomic concurrency locks, and real-time open slot computation.
- **Decision:** Decompose the abstract PRD "Availability" entity into three distinct, normalized relational models:
  1. `WorkingHour`: Defines recurring weekly shift templates on a doctor's `Calendar` (`dayOfWeek` 0–6, `startTime` "09:00", `endTime` "17:00", `hospitalId`).
  2. `BlockedSlot`: Stores calendar blackout periods, vacation/leaves, provider sickness, or administrative blocks (`calendarId`, `hospitalId`, `startTime`, `endTime`, `reason`).
  3. `Slot`: Concrete, discrete, bookable time windows computed by `SlotCalculator` respecting `WorkingHour`, `BlockedSlot`, duration minutes (e.g., 30m), and buffers. Each slot has atomic flags (`isBooked`, `isBlocked`), foreign keys to `Doctor` and `Hospital`, and unique constraints (`@@unique([doctorId, startTime])`).
- **Reasoning:**
  1. **Separation of Policy, Exceptions, and State:** Recurring schedule rules (`WorkingHour`) represent organizational policy; blackout windows (`BlockedSlot`) represent schedule exceptions; bookable slots (`Slot`) represent transactional state. Collapsing them into a single table or JSON blob would prevent relational integrity.
  2. **Atomic Concurrency & Race Condition Prevention:** PRD Section 7 mandates preventing concurrent double-booking. Having discrete `Slot` rows allows atomic, single-row locking (`reserveSlotAtomically` via optimistic or row-level locking) without table-wide locks or complex runtime interval overlap math during high-concurrency patient phone calls.
  3. **Sub-Millisecond AI Voice Inquiries:** The Gemini voice agent must check availability in <200ms. Querying indexed `Slot` rows (`WHERE hospitalId = ? AND doctorId = ? AND isBooked = false AND isBlocked = false AND startTime >= ?`) provides fast, index-accelerated query plans.
- **Consequences:** Generating or recalculating schedules writes to `Slot` rows using `WorkingHour` and `BlockedSlot` as inputs.



