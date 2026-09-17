# AI.Prof Evaluation Demo Script: 13-Scene Walkthrough

> **Specification Reference:** PRD Section 29 (Demonstration Scenario & Final Verification)  
> **Target Audience:** Evaluators, Clinical Informatics Officers, Platform Engineers  
> **Environment Prerequisites:** All services running (`pnpm dev`), seeded database, browser at `http://localhost:5173`.

---

## Quick Reference: Demo Credentials

| Role | Email | Password | Tenant Scope | Portal URL |
| :--- | :--- | :--- | :--- | :--- |
| **Platform Admin** | `platform.admin@health.org` | `Password123!` | System-wide (All Hospitals) | [http://localhost:5173/dashboards/platform-admin](http://localhost:5173/dashboards/platform-admin) |
| **Hospital Admin** | `admin@apexhealth.org` | `Password123!` | Apex Regional Medical Center | [http://localhost:5173/dashboards/hospital-admin](http://localhost:5173/dashboards/hospital-admin) |
| **Doctor** | `dr.rao@apexhealth.org` | `Password123!` | Dr. Arvind Rao (Orthopedics) | [http://localhost:5173/dashboards/doctor](http://localhost:5173/dashboards/doctor) |
| **Patient** | `jane.doe@example.com` | `Password123!` | Jane Doe | [http://localhost:5173/dashboards/patient](http://localhost:5173/dashboards/patient) |

---

## Scene 1: Hospital Self-Service Setup & Platform Admin Approval

### Objective
Demonstrate that a new hospital can register in `DRAFT` status, that operational readiness gates block unapproved hospitals from receiving appointments, and that Platform Admin can review and transition the hospital to `APPROVED`.

### Steps to Perform
1. Open the browser to `http://localhost:5173`.
2. Navigate to **Hospital Self-Service Onboarding** (`/onboarding` or via Platform Admin dashboard).
3. Register a new hospital:
   - **Name:** *"St. Jude Community Hospital"*
   - **City:** *"Denver"*
   - **State:** *"CO"*
   - **EHR Type:** `EPIC`
4. Observe that the hospital is registered with status `DRAFT`.
5. **Demonstrate Operational Readiness Gate (PRD Section 5):**
   - Attempt to book an appointment or publish slots for St. Jude. The platform strictly rejects this with:  
     `"Operational Gate Blocked: Hospital is in DRAFT status and cannot receive appointments."`
6. Log in as **Platform Admin** (`platform.admin@health.org` / `Password123!`).
7. In the **Hospital Applications & Approval** table, select *"St. Jude Community Hospital"*.
8. Click **Approve Hospital**. Observe the status change from `UNDER_REVIEW` to `APPROVED`.
9. Verify that an audit event is recorded in the platform audit trail.

---

## Scene 2: Doctor Onboarding & Scheduling Setup

### Objective
Demonstrate inviting a doctor to the approved hospital, setting their consultation specialties, and configuring working hours.

### Steps to Perform
1. Log in as **Hospital Admin** (`admin@apexhealth.org` / `Password123!`).
2. Navigate to the **Doctors & Roster** tab.
3. Verify that **Dr. Arvind Rao** is listed with status `ACTIVE`:
   - **Specialty:** *Orthopedic Surgery*
   - **Consultation Types:** `["Initial Consultation", "Follow-up", "Urgent Orthopedic Evaluation"]`
   - **Appointment Duration:** 30 minutes.
4. Click into **Doctor Schedule & Working Hours**:
   - Confirm Dr. Rao's working hours are set Monday through Friday from `08:00` to `18:00`.
   - Add or verify a blocked period: *"Staff Surgical Review - 12:00 to 13:00"*.

---

## Scene 3: Availability Definition (No Invented Slots Guarantee)

### Objective
Prove that the scheduling engine computes slots strictly from database records, working hours, and doctor state—never fabricating availability.

### Steps to Perform
1. From the terminal or API client, execute availability check for Dr. Rao:
   ```bash
   curl -s "http://localhost:3001/api/doctors/check-availability?doctorId=<DOCTOR_ID>&startDate=2026-09-17T00:00:00Z&endDate=2026-09-24T00:00:00Z" | jq .
   ```
2. Observe that only slots falling within `08:00`–`18:00` on active days are returned.
3. Observe that slots overlapping the blocked period (`12:00`–`13:00`) or doctor leave are automatically excluded.
4. Demonstrate that querying an invalid doctor or doctor with no calendar returns an empty array `[]`—zero hallucination.

---

## Scene 4: Patient Discovery & Search

### Objective
Demonstrate patient search by medical specialty and geographic region.

### Steps to Perform
1. Log in as **Patient** (`jane.doe@example.com` / `Password123!`) or use the public Patient Portal at `/dashboards/patient`.
2. In the search box, enter *"orthopedics"* or *"cardiologist"*.
3. Observe the structured search results displaying:
   - **Hospital:** *Apex Regional Medical Center*
   - **Doctor:** *Dr. Arvind Rao (Orthopedic Surgery)*
   - **Earliest Available Date:** Next available verified opening.

---

## Scene 5: AI Voice Assistant Interaction (Web Voice HUD)

### Objective
Demonstrate the real-time AI Voice Assistant with live audio visualizer, turn-taking, and barge-in capability.

### Steps to Perform
1. On the Patient Dashboard, locate the **AI Patient Access Assistant** widget in the bottom-right corner.
2. Click **Start Voice Call** (or switch to Voice Mode).
3. Observe the animated Web Audio visualizer responding to voice activity.
4. Speak: *"Hello, can you tell me what hospitals you support?"*
5. Listen to the streaming voice response:  
   *"Apex Regional Medical Center and Metropolitan Health System are currently available in our network..."*
6. **Demonstrate Barge-In (Interruption):**  
   While the agent is speaking, speak: *"Actually, can I speak to an orthopedic specialist?"*  
   Observe that the agent immediately stops playback, handles the audio interruption, and addresses the new request.

---

## Scene 6: Natural-Language Appointment Booking & Clarification-Over-Guessing

### Objective
Demonstrate the AI Agent's intent detection, clarification when faced with ambiguous requests, and reference resolution.

### Steps to Perform
1. In the text-chat or voice interface, enter:  
   **Patient:** *"Can you book Dr. Rao for me?"*
2. **Observe Clarification-Over-Guessing (PRD Section 9 & 10):**  
   Instead of picking an arbitrary slot, the agent responds:  
   **Agent:** *"Dr. Arvind Rao has 3 available appointment slots: Thursday at 10:00 AM, Friday at 10:00 AM, or Friday at 2:00 PM. Which one would you prefer?"*
3. **Demonstrate Reference Resolution (PRD Section 10):**  
   **Patient:** *"What openings does he have tomorrow?"*  
   **Agent:** Resolves pronoun *"he"* to Dr. Rao and checks tomorrow's slots.  
   **Patient:** *"Actually, make that Friday."*  
   **Agent:** Resolves *"that"* to Dr. Rao's Friday schedule: *"I have updated the day to Friday. Dr. Arvind Rao has openings at 10:00 AM and 2:00 PM. Which time would you prefer?"*  
   **Patient:** *"Book the morning one."*
4. The agent executes `create_appointment` with `slotId` corresponding to Friday 10:00 AM.

---

## Scene 7: Integration Layer & Mock EHR Sync

### Objective
Demonstrate that the platform reserves an internal `Pending` hold, normalizes vendor EHR payloads, and dispatches the booking to the external EHR.

### Steps to Perform
1. Review the terminal logs for `@health/api-server` and `@health/mock-ehr`.
2. Notice the sequential logging:
   ```json
   {"msg": "Creating internal appointment in Pending status", "appointmentId": "..."}
   {"msg": "Executing Mock EHR appointment creation request", "externalProviderId": "EXT-DOC-RAO"}
   {"msg": "Mock EHR created external appointment", "externalAppointmentId": "EXT-EHR-APPT-..."}
   ```
3. Observe that internal and external identifier mappings (`PatientId`, `DoctorId`, `AppointmentId`) are written to the database.

---

## Scene 8: Post-Operation Verification & State Synchronization

### Objective
Demonstrate that an appointment NEVER confirms until verified in the external EHR system.

### Steps to Perform
1. Observe the Verifier (`@health/verification`) querying the Mock EHR server:
   ```json
   {"msg": "Executing post-operation external verification", "externalAppointmentId": "EXT-EHR-APPT-..."}
   {"msg": "External verification PASSED: EHR status is CONFIRMED"}
   ```
2. The State Synchronizer advances the internal appointment from `Pending` → `Confirmed`.
3. The AI Agent informs the patient:  
   *"Great news! Your appointment with Dr. Arvind Rao has been verified and confirmed for Friday at 10:00 AM."*

---

## Scene 9: Pre-Visit Questionnaire Assignment & Intake

### Objective
Demonstrate automated pre-visit intake question assignment, conversational completion, and administrative keyword escalation.

### Steps to Perform
1. Following confirmation, the agent initiates conversational intake:  
   **Agent:** *"Before your visit, would you like to answer two quick intake questions for Dr. Rao?"*  
   **Patient:** *"Yes, I am ready."*  
   **Agent:** *"What symptoms or pain have you been experiencing?"*  
   **Patient:** *"I have severe chest pain that started this morning."*
2. **Observe Administrative Keyword Escalation (PRD Section 11):**  
   The system detects the acute danger keyword *"chest pain"*.
3. The questionnaire response is immediately flagged: `flaggedUrgent: true`, reason: `"Administrative keyword trigger detected: 'chest pain'"`.
4. A high-priority notification is dispatched to the clinic staff inbox.

---

## Scene 10: Operational Workflow Execution

### Objective
Demonstrate background workflow scheduling, condition evaluation (`APPOINTMENT_NOT_CANCELLED`), and delayed reminder dispatch.

### Steps to Perform
1. Check the **Workflows & Background Jobs** panel in Hospital Admin dashboard.
2. Verify that two workflow executions were triggered:
   - `PreVisitQuestionnaire`: Dispatched immediately.
   - `AppointmentReminder`: Scheduled for 24 hours prior to appointment start time with condition check `APPOINTMENT_NOT_CANCELLED`.
3. If an appointment is cancelled, the condition check fails gracefully and skips reminder dispatch without error.

---

## Scene 11: Doctor Dashboard Review

### Objective
Demonstrate doctor appointment review, schedule inspection, and pre-visit intake response visibility.

### Steps to Perform
1. Log in as **Doctor** (`dr.rao@apexhealth.org` / `Password123!`).
2. Navigate to **Today's & Upcoming Appointments**:
   - Verify Jane Doe's appointment is displayed for Friday at 10:00 AM with status `Confirmed`.
3. Click **View Pre-Visit Questionnaire**:
   - Observe Jane Doe's intake answers.
   - Observe the prominent red banner: `⚠️ URGENT CLINICAL REVIEW: Patient reported 'chest pain'`.
4. Verify that Doctor A cannot see appointments from Doctor B (tenant & provider isolation).

---

## Scene 12: Platform Admin Oversight & Telemetry

### Objective
Demonstrate operational health monitoring, AI evaluation metrics, and privacy-preserving audit logs.

### Steps to Perform
1. Log in as **Platform Admin** (`platform.admin@health.org` / `Password123!`).
2. Navigate to `/dashboards/platform-admin`:
   - **System Overview:** Total Hospitals (2), Total Active Doctors (2), Total Confirmed Appointments.
   - **AI Evaluation Telemetry:**
     - Intent Detection Accuracy: `100%`
     - Clarification Trigger Rate: `100%`
     - Clinical Safety Refusal Rate: `100%`
   - **Audit Events:** Observe structured capability logs where patient PHI (health notes, symptom text) is automatically replaced with `[REDACTED_PHI]`.

---

## Scene 13: Failure & Recovery Scenarios (PRD Section 28)

### Objective
Demonstrate automated recovery from EHR timeouts without creating duplicate bookings (Scenario B), and escalation to human reconciliation upon exhausted retries (Scenario C).

### Option B: Unknown Outcome Recovery (No Duplicate Created)
1. Run the Option B verification test:
   ```bash
   npx tsx --test --test-name-pattern="Option B" tests/integration/failure-recovery.test.ts
   ```
2. **Observe System Behavior:**
   - Client sends appointment creation request.
   - Network timeout occurs before response is received (state is `UNKNOWN_OUTCOME`).
   - Recovery State Machine classifies operation as `UNKNOWN_OUTCOME` and queries Mock EHR state.
   - The external appointment record is discovered.
   - State synchronizer synchronizes local record to `Confirmed` without creating a second EHR booking.

### Option C: Retries Exhausted → Reconciliation Record Created
1. Run the Option C verification test:
   ```bash
   npx tsx --test --test-name-pattern="Option C" tests/integration/failure-recovery.test.ts
   ```
2. **Observe System Behavior:**
   - Mock EHR simulates a persistent hard failure / 500 service unavailable.
   - Idempotent retries are executed with exponential backoff.
   - Retries exhaust after 3 attempts.
   - System creates a `ReconciliationRecord` in the database with status `PENDING_OPERATOR_REVIEW`.
   - High-priority operational event alerts the Platform and Hospital Admin dashboards for human resolution.
