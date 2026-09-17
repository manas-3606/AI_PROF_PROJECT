import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { CapabilityRegistry } from '@health/capabilities';
import crypto from 'node:crypto';

describe('Integration Test: Multi-Tenant Isolation & Role-Based Access Control (RBAC)', () => {
  let hospitalA: any;
  let hospitalB: any;
  let doctorA: any;
  let doctorB: any;
  let patientA: any;
  let patientB: any;
  let appointmentA: any;
  let appointmentB: any;
  let questionnaireB: any;
  let conversationB: any;

  before(async () => {
    // 1. Fetch hospitals
    hospitalA = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
    hospitalB = await prisma.hospital.findFirst({ where: { slug: 'metropolitan-health' } });
    assert.ok(hospitalA, 'Hospital A must exist');
    assert.ok(hospitalB, 'Hospital B must exist');

    // 2. Fetch or create doctors in both hospitals
    doctorA = await prisma.doctor.findFirst({ where: { hospitalId: hospitalA.id } });
    assert.ok(doctorA, 'Doctor in Hospital A must exist');

    doctorB = await prisma.doctor.findFirst({ where: { hospitalId: hospitalB.id } });
    if (!doctorB) {
      const userDocB = await prisma.user.create({
        data: {
          email: `dr.carter.${Date.now()}@metrohealth.org`,
          passwordHash: 'dummy',
          name: 'Dr. Evelyn Carter',
          role: 'DOCTOR',
          hospitalId: hospitalB.id,
        },
      });

      doctorB = await prisma.doctor.create({
        data: {
          userId: userDocB.id,
          hospitalId: hospitalB.id,
          name: 'Dr. Evelyn Carter',
          specialty: 'Neurology',
          department: 'Neurology Department',
          qualifications: 'MD, Board Certified Neurologist',
          appointmentDurationMinutes: 30,
          status: 'ACTIVE',
        },
      });
    }

    // 3. Patients
    const patients = await prisma.patient.findMany({ take: 2 });
    patientA = patients[0];
    patientB = patients[1] || patients[0];

    // 4. Appointments
    appointmentA = await prisma.appointment.findFirst({ where: { hospitalId: hospitalA.id } });

    const slotB = await prisma.slot.create({
      data: {
        doctorId: doctorB.id,
        hospitalId: hospitalB.id,
        startTime: new Date(Date.now() + 86400000),
        endTime: new Date(Date.now() + 86400000 + 1800000),
        isBooked: true,
      },
    });

    appointmentB = await prisma.appointment.create({
      data: {
        hospital: { connect: { id: hospitalB.id } },
        doctor: { connect: { id: doctorB.id } },
        patient: { connect: { id: patientB.id } },
        slot: { connect: { id: slotB.id } },
        startTime: new Date(Date.now() + 86400000),
        endTime: new Date(Date.now() + 86400000 + 1800000),
        status: 'CONFIRMED',
        externalAppointmentId: `EHR-METRO-${crypto.randomUUID().slice(0, 6)}`,
      },
    });

    // 5. Questionnaire in Hospital B
    questionnaireB = await prisma.questionnaire.create({
      data: {
        hospital: { connect: { id: hospitalB.id } },
        title: 'Neurology Pre-Intake Form',
        specialty: 'Neurology',
      },
    });

    // 6. Conversation in Hospital B
    conversationB = await prisma.aiConversation.create({
      data: {
        patient: { connect: { id: patientB.id } },
        channel: 'web_voice',
      },
    });
    await prisma.aiContext.create({
      data: {
        conversation: { connect: { id: conversationB.id } },
        selectedHospitalId: hospitalB.id,
        currentIntent: 'BOOKING_INTENT',
      },
    });
  });

  // --- SECTION 1: TENANT ISOLATION NEGATIVE TESTS ---
  describe('Tenant Isolation Enforcement', () => {
    it('rejects and audits Hospital A actor attempting to read Hospital B appointment', async () => {
      const correlationId = crypto.randomUUID();
      let rejected = false;

      try {
        await CapabilityRegistry.execute(
          'get_appointment',
          { appointmentId: appointmentB.id },
          { tenantId: hospitalA.id, correlationId }
        );
      } catch (err: any) {
        rejected = true;
        assert.ok(
          err.message.includes('Cross-tenant access forbidden') || err.message.includes('hospital'),
          'Must specify cross-tenant restriction'
        );
      }

      assert.strictEqual(rejected, true, 'Hospital A actor must not read Hospital B appointment');

      // Verify security audit log exists
      const auditLog = await prisma.operationalEvent.findFirst({
        where: {
          correlationId,
          eventType: 'SECURITY_VIOLATION',
        },
      });
      assert.ok(auditLog, 'Security violation must be audited in OperationalEvent table');
    });

    it('rejects and audits Hospital A actor attempting to cancel/modify Hospital B appointment', async () => {
      const correlationId = crypto.randomUUID();
      let rejected = false;

      try {
        await CapabilityRegistry.execute(
          'cancel_appointment',
          { appointmentId: appointmentB.id, reason: 'Unauthorized cancel attempt' },
          { tenantId: hospitalA.id, correlationId }
        );
      } catch (err: any) {
        rejected = true;
        assert.ok(err.message.includes('Cross-tenant access forbidden'));
      }

      assert.strictEqual(rejected, true, 'Hospital A actor must not cancel Hospital B appointment');

      const auditLog = await prisma.operationalEvent.findFirst({
        where: {
          correlationId,
          eventType: 'SECURITY_VIOLATION',
        },
      });
      assert.ok(auditLog, 'Security violation must be audited in OperationalEvent table');
    });

    it('rejects and audits Hospital A actor attempting to access Hospital B doctor roster', async () => {
      const correlationId = crypto.randomUUID();
      let rejected = false;

      try {
        await CapabilityRegistry.execute(
          'search_doctors',
          { hospitalId: hospitalB.id },
          { tenantId: hospitalA.id, correlationId }
        );
      } catch (err: any) {
        rejected = true;
        assert.ok(err.message.includes('Cross-tenant access forbidden'));
      }

      assert.strictEqual(rejected, true, 'Hospital A actor must not query Hospital B doctor roster');

      const auditLog = await prisma.operationalEvent.findFirst({
        where: {
          correlationId,
          eventType: 'SECURITY_VIOLATION',
        },
      });
      assert.ok(auditLog, 'Security violation must be audited in OperationalEvent table');
    });

    it('rejects and audits Hospital A actor attempting to access Hospital B questionnaire', async () => {
      const correlationId = crypto.randomUUID();
      let rejected = false;

      try {
        await CapabilityRegistry.execute(
          'get_questionnaire',
          { hospitalId: hospitalB.id },
          { tenantId: hospitalA.id, correlationId }
        );
      } catch (err: any) {
        rejected = true;
        assert.ok(err.message.includes('Cross-tenant access forbidden'));
      }

      assert.strictEqual(rejected, true, 'Hospital A actor must not access Hospital B questionnaire');

      const auditLog = await prisma.operationalEvent.findFirst({
        where: {
          correlationId,
          eventType: 'SECURITY_VIOLATION',
        },
      });
      assert.ok(auditLog, 'Security violation must be audited in OperationalEvent table');
    });

    it('rejects and audits Hospital A actor attempting to access Hospital B conversation context', async () => {
      const correlationId = crypto.randomUUID();
      let rejected = false;

      try {
        await CapabilityRegistry.execute(
          'get_context',
          { conversationId: conversationB.id },
          { tenantId: hospitalA.id, correlationId }
        );
      } catch (err: any) {
        rejected = true;
        assert.ok(err.message.includes('Cross-tenant access forbidden'));
      }

      assert.strictEqual(rejected, true, 'Hospital A actor must not access Hospital B conversation');

      const auditLog = await prisma.operationalEvent.findFirst({
        where: {
          correlationId,
          eventType: 'SECURITY_VIOLATION',
        },
      });
      assert.ok(auditLog, 'Security violation must be audited in OperationalEvent table');
    });
  });

  // --- SECTION 2: RBAC NEGATIVE TESTS ---
  describe('Role-Based Access Control (RBAC) Negative Tests', () => {
    it('rejects and audits Patient token attempting to access another patient’s appointment', async () => {
      const correlationId = crypto.randomUUID();
      let rejected = false;

      try {
        await CapabilityRegistry.execute(
          'get_appointment',
          { appointmentId: appointmentA.id },
          {
            actorRole: 'PATIENT',
            patientId: 'unauthorized-stranger-patient-id',
            correlationId,
          }
        );
      } catch (err: any) {
        rejected = true;
        assert.ok(err.message.includes('Access denied') || err.message.includes('Patient cannot access'));
      }

      assert.strictEqual(rejected, true, 'Patient must not access another patient appointment');

      const auditLog = await prisma.operationalEvent.findFirst({
        where: {
          correlationId,
          eventType: 'SECURITY_VIOLATION',
        },
      });
      assert.ok(auditLog, 'RBAC violation must be audited in OperationalEvent table');
    });

    it('rejects and audits Doctor token attempting to access another doctor’s private appointment', async () => {
      const correlationId = crypto.randomUUID();
      let rejected = false;

      try {
        await CapabilityRegistry.execute(
          'get_appointment',
          { appointmentId: appointmentA.id },
          {
            actorRole: 'DOCTOR',
            doctorId: doctorB.id, // Doctor B attempting to access Doctor A appointment
            correlationId,
          }
        );
      } catch (err: any) {
        rejected = true;
        assert.ok(err.message.includes('Access denied') || err.message.includes('Doctor cannot access'));
      }

      assert.strictEqual(rejected, true, 'Doctor must not access another doctor appointment');

      const auditLog = await prisma.operationalEvent.findFirst({
        where: {
          correlationId,
          eventType: 'SECURITY_VIOLATION',
        },
      });
      assert.ok(auditLog, 'RBAC violation must be audited in OperationalEvent table');
    });
  });
});
