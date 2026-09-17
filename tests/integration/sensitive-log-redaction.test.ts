import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { CapabilityRegistry, StubEhrConnector } from '@health/capabilities';
import { SlotCalculator } from '@health/scheduling';
import crypto from 'node:crypto';

describe('PRD Section 21 & Section 19: Sensitive PHI Log Redaction & Privacy Verification', () => {
  const SECRET_PHI_STRING_1 = 'TEST_SENSITIVE_PHI_MEDICATION_QUERY_99999';
  const SECRET_PHI_STRING_2 = 'CONFIDENTIAL_PATIENT_MEDICAL_HISTORY_DIAGNOSIS_88888';
  const SECRET_PHONE = '+1-555-987-6543';
  const SECRET_EMAIL = 'patient.confidential.9999@example.com';

  let hospital: any;
  let doctor: any;
  let patient: any;
  let questionnaire: any;
  let slot: any;

  async function getOrCreateAvailableSlot(docId: string, hospId: string) {
    const doc = await prisma.doctor.findUnique({
      where: { id: docId },
      include: { calendar: { include: { workingHours: true } } },
    });
    assert.ok(doc && doc.calendar);
    const workingHours = doc.calendar.workingHours || [];

    const candidates = await prisma.slot.findMany({
      where: { doctorId: docId, isBooked: false, isBlocked: false },
      orderBy: { startTime: 'asc' },
    });

    for (const cand of candidates) {
      if (SlotCalculator.isWithinWorkingHours(cand.startTime, cand.endTime, workingHours)) {
        return cand;
      }
    }

    const wh = workingHours[0];
    assert.ok(wh, 'Doctor working hours must exist');
    const [startH, startM] = wh.startTime.split(':').map(Number);

    const d = new Date();
    d.setDate(d.getDate() + ((wh.dayOfWeek - d.getDay() + 7) % 7 || 7));
    d.setHours(startH, startM, 0, 0);

    let testStartTime = new Date(d);
    while (
      (await prisma.slot.findFirst({ where: { doctorId: docId, startTime: testStartTime } })) ||
      !SlotCalculator.isWithinWorkingHours(
        testStartTime,
        new Date(testStartTime.getTime() + 30 * 60 * 1000),
        workingHours
      )
    ) {
      testStartTime = new Date(testStartTime.getTime() + 30 * 60 * 1000);
      if (testStartTime.getHours() >= 17) {
        testStartTime.setDate(testStartTime.getDate() + 1);
        testStartTime.setHours(startH, startM, 0, 0);
      }
    }
    const testEndTime = new Date(testStartTime.getTime() + 30 * 60 * 1000);

    return await prisma.slot.create({
      data: {
        doctorId: docId,
        hospitalId: hospId,
        startTime: testStartTime,
        endTime: testEndTime,
        isBooked: false,
        isBlocked: false,
      },
    });
  }

  before(async () => {
    // 1. Fetch seeded test entities
    hospital = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
    assert.ok(hospital, 'Hospital must exist');

    doctor = await prisma.doctor.findFirst({
      where: { hospitalId: hospital.id, status: 'ACTIVE' },
      include: { calendar: { include: { workingHours: true } } },
    });
    assert.ok(doctor, 'Doctor must exist');

    patient = await prisma.patient.findFirst();
    assert.ok(patient, 'Patient must exist');

    questionnaire = await prisma.questionnaire.findFirst({
      where: { hospitalId: hospital.id },
    });
    assert.ok(questionnaire, 'Questionnaire must exist');

    slot = await getOrCreateAvailableSlot(doctor.id, hospital.id);

    CapabilityRegistry.setHealthcareConnector(new StubEhrConnector());
  });

  it('1. Capability audit events strictly redact free-text medical answers and notes', async () => {
    const correlationId = `redaction-test-${crypto.randomUUID()}`;
    const freshSlot = await getOrCreateAvailableSlot(doctor.id, hospital.id);

    let activeQuestionnaire = await prisma.questionnaire.findFirst({
      where: { hospitalId: hospital.id },
    });
    if (!activeQuestionnaire) {
      activeQuestionnaire = await prisma.questionnaire.create({
        data: {
          hospitalId: hospital.id,
          title: 'Redaction Test Intake',
          specialty: 'General',
        },
      });
    }

    // 1. Book appointment with sensitive reason and phone
    const appt = await CapabilityRegistry.execute(
      'create_appointment',
      {
        patientId: patient.id,
        doctorId: doctor.id,
        hospitalId: hospital.id,
        slotId: freshSlot.id,
        reason: `Routine visit regarding ${SECRET_PHI_STRING_1}`,
        idempotencyKey: crypto.randomUUID(),
      },
      {
        actorRole: 'PATIENT',
        patientId: patient.id,
        tenantId: hospital.id,
        correlationId,
      }
    );

    // 2. Submit questionnaire with secret medical free-text responses
    await CapabilityRegistry.execute(
      'submit_questionnaire',
      {
        questionnaireId: activeQuestionnaire.id,
        appointmentId: appt.appointmentId,
        patientId: patient.id,
        responses: {
          medical_condition: SECRET_PHI_STRING_2,
          current_medications: 'Metformin, Lisinopril, SecretRx',
          emergency_contact_phone: SECRET_PHONE,
          confidential_email: SECRET_EMAIL,
        },
      },
      {
        actorRole: 'PATIENT',
        patientId: patient.id,
        tenantId: hospital.id,
        correlationId,
      }
    );

    // 3. Query all AuditEvent records emitted for this correlation ID
    const auditLogs = await prisma.auditEvent.findMany({
      where: { correlationId },
    });
    assert.ok(auditLogs.length >= 2, 'Expected audit logs to be emitted');

    // 4. Assert that sensitive strings are NEVER present verbatim in audit logs
    for (const log of auditLogs) {
      const details = log.detailsJson || '';

      assert.strictEqual(
        details.includes(SECRET_PHI_STRING_1),
        false,
        `Audit log details must not contain sensitive string 1: ${SECRET_PHI_STRING_1}`
      );

      assert.strictEqual(
        details.includes(SECRET_PHI_STRING_2),
        false,
        `Audit log details must not contain sensitive string 2: ${SECRET_PHI_STRING_2}`
      );

      assert.strictEqual(
        details.includes(SECRET_PHONE),
        false,
        `Audit log details must not contain unmasked phone: ${SECRET_PHONE}`
      );

      assert.strictEqual(
        details.includes(SECRET_EMAIL),
        false,
        `Audit log details must not contain unmasked email: ${SECRET_EMAIL}`
      );
    }

    // 5. Query all OperationalEvent records emitted for this correlation ID
    const opEvents = await prisma.operationalEvent.findMany({
      where: { correlationId },
    });

    for (const op of opEvents) {
      const msg = `${op.message} ${op.metadataJson || ''}`;
      assert.strictEqual(
        msg.includes(SECRET_PHI_STRING_1),
        false,
        `Operational event must not contain sensitive string 1: ${SECRET_PHI_STRING_1}`
      );
      assert.strictEqual(
        msg.includes(SECRET_PHI_STRING_2),
        false,
        `Operational event must not contain sensitive string 2: ${SECRET_PHI_STRING_2}`
      );
    }
  });

  it('2. Capability registry privacy sanitizer replaces free-text PHI with structured redact tokens', async () => {
    const correlationId = `privacy-audit-test-${crypto.randomUUID()}`;

    await CapabilityRegistry.execute(
      'lookup_patient',
      {
        tenantId: hospital.id,
        identifier: {
          phone: SECRET_PHONE,
          email: SECRET_EMAIL,
        },
      },
      {
        actorRole: 'DOCTOR',
        doctorId: doctor.id,
        tenantId: hospital.id,
        correlationId,
      }
    );

    const lookupAudit = await prisma.auditEvent.findFirst({
      where: {
        correlationId,
        action: 'CAPABILITY_LOOKUP_PATIENT',
      },
    });

    assert.ok(lookupAudit, 'Audit log for lookup_patient must exist');
    const details = JSON.parse(lookupAudit.detailsJson || '{}');

    // Phone must be masked (only last 4 visible or masked)
    assert.strictEqual(details.inputSummary.identifier?.phone?.includes(SECRET_PHONE), false);
    assert.ok(details.inputSummary.identifier?.phone?.includes('***'));

    // Email must be masked
    assert.strictEqual(details.inputSummary.identifier?.email?.includes(SECRET_EMAIL), false);
    assert.ok(details.inputSummary.identifier?.email?.includes('***'));
  });
});
