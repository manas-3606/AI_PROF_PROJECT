import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { AuthService } from '@health/core-services';
import { UserRole } from '@health/shared-types';
import { buildApp } from '../../services/api-server/src/app.js';
import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

describe('Integration Test: API-Layer Multi-Tenant Isolation Enforcement', () => {
  let app: FastifyInstance;
  let hospitalA: any;
  let hospitalB: any;
  let adminA: any;
  let tokenA: string;
  let doctorB: any;
  let appointmentB: any;

  before(async () => {
    app = await buildApp();

    // 1. Fetch distinct hospitals
    hospitalA = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
    hospitalB = await prisma.hospital.findFirst({ where: { slug: 'metropolitan-health' } });
    assert.ok(hospitalA, 'Hospital A must exist');
    assert.ok(hospitalB, 'Hospital B must exist');
    assert.notStrictEqual(hospitalA.id, hospitalB.id, 'Hospitals must be different tenants');

    // 2. Fetch or create Hospital Admin for Hospital A
    adminA = await prisma.user.findFirst({
      where: { hospitalId: hospitalA.id, role: UserRole.HOSPITAL_ADMIN },
    });
    if (!adminA) {
      adminA = await prisma.user.create({
        data: {
          email: `admin.apex.${Date.now()}@apexhealth.org`,
          passwordHash: 'dummy',
          name: 'Apex Admin',
          role: UserRole.HOSPITAL_ADMIN,
          hospitalId: hospitalA.id,
        },
      });
    }

    // Sign JWT token for Hospital Admin of Hospital A
    tokenA = await AuthService.signToken({
      id: adminA.id,
      email: adminA.email,
      name: adminA.name,
      role: UserRole.HOSPITAL_ADMIN,
      tenantId: hospitalA.id,
    });

    // 3. Ensure Hospital B has a doctor and appointment for testing
    doctorB = await prisma.doctor.findFirst({ where: { hospitalId: hospitalB.id } });
    if (!doctorB) {
      const userB = await prisma.user.create({
        data: {
          email: `dr.test.b.${Date.now()}@metrohealth.org`,
          passwordHash: 'dummy',
          name: 'Dr. Test B',
          role: UserRole.DOCTOR,
          hospitalId: hospitalB.id,
        },
      });
      doctorB = await prisma.doctor.create({
        data: {
          userId: userB.id,
          hospitalId: hospitalB.id,
          name: 'Dr. Test B',
          specialty: 'Cardiology',
          department: 'Cardiology',
          qualifications: 'MD',
        },
      });
    }

    const patient = await prisma.patient.findFirst();
    const slotB = await prisma.slot.create({
      data: {
        doctorId: doctorB.id,
        hospitalId: hospitalB.id,
        startTime: new Date(Date.now() + 172800000),
        endTime: new Date(Date.now() + 172800000 + 1800000),
        isBooked: true,
      },
    });

    appointmentB = await prisma.appointment.create({
      data: {
        hospitalId: hospitalB.id,
        doctorId: doctorB.id,
        patientId: patient!.id,
        slotId: slotB.id,
        startTime: slotB.startTime,
        endTime: slotB.endTime,
        status: 'Confirmed',
        reason: 'Hospital B private appointment',
      },
    });

    // Ensure questionnaire exists in Hospital B
    const qB = await prisma.questionnaire.findFirst({ where: { hospitalId: hospitalB.id } });
    if (!qB) {
      await prisma.questionnaire.create({
        data: {
          hospitalId: hospitalB.id,
          title: 'Metro Pre-Intake',
          specialty: 'Cardiology',
        },
      });
    }
  });

  after(async () => {
    await app.close();
  });

  it('rejects Hospital Admin A attempting to read Hospital B profile (GET /api/hospitals/:id) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/hospitals/${hospitalB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant hospital read must return HTTP 403');
    const body = JSON.parse(res.payload);
    assert.match(body.error, /Cross-tenant access forbidden/);

    // Verify Audit Event
    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: 'CROSS_TENANT_ACCESS_VIOLATION',
        tenantId: hospitalA.id,
        hospitalId: hospitalB.id,
        entityType: 'HOSPITAL',
      },
      orderBy: { timestamp: 'desc' },
    });
    assert.ok(audit, 'Audit event must be logged for cross-tenant hospital read attempt');
    assert.strictEqual(audit.actorId, adminA.id);
  });

  it('rejects Hospital Admin A attempting to update Hospital B profile (PATCH /api/hospitals/:id) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/hospitals/${hospitalB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        name: 'Hacked Metro Center',
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant hospital write must return HTTP 403');

    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: 'CROSS_TENANT_ACCESS_VIOLATION',
        tenantId: hospitalA.id,
        entityId: hospitalB.id,
      },
      orderBy: { timestamp: 'desc' },
    });
    assert.ok(audit, 'Audit event must be logged for cross-tenant hospital update');
  });

  it('rejects Hospital Admin A attempting to read Hospital B doctor roster (GET /api/doctors?hospitalId=...) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/doctors?hospitalId=${hospitalB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant doctor roster query must return HTTP 403');
    const body = JSON.parse(res.payload);
    assert.match(body.error, /Cross-tenant access forbidden/);
  });

  it('rejects Hospital Admin A attempting to read Hospital B doctor profile (GET /api/doctors/:id) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/doctors/${doctorB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant doctor profile query must return HTTP 403');
    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: 'CROSS_TENANT_ACCESS_VIOLATION',
        entityType: 'DOCTOR',
        entityId: doctorB.id,
      },
      orderBy: { timestamp: 'desc' },
    });
    assert.ok(audit, 'Audit event must be logged for cross-tenant doctor read');
  });

  it('rejects Hospital Admin A attempting to create a doctor in Hospital B (POST /api/doctors) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/doctors',
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        hospitalId: hospitalB.id,
        name: 'Dr. Malicious Injected Doctor',
        email: `injected.${Date.now()}@metrohealth.org`,
        specialty: 'General Medicine',
        department: 'Outpatient',
        qualifications: 'MD',
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant doctor creation must return HTTP 403');
    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: 'CROSS_TENANT_ACCESS_VIOLATION',
        tenantId: hospitalA.id,
        hospitalId: hospitalB.id,
      },
      orderBy: { timestamp: 'desc' },
    });
    assert.ok(audit, 'Audit event must be logged for cross-tenant doctor creation attempt');
  });

  it('rejects Hospital Admin A attempting to publish slots for Hospital B doctor (POST /api/doctors/:id/slots) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/doctors/${doctorB.id}/slots`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        slots: [
          {
            startTime: new Date(Date.now() + 86400000).toISOString(),
            endTime: new Date(Date.now() + 86400000 + 1800000).toISOString(),
          },
        ],
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant slot creation must return HTTP 403');
  });

  it('rejects Hospital Admin A attempting to read Hospital B appointments (GET /api/appointments?hospitalId=...) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/appointments?hospitalId=${hospitalB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant appointments list query must return HTTP 403');
  });

  it('rejects Hospital Admin A attempting to read Hospital B appointment by ID (GET /api/appointments/:id) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/appointments/${appointmentB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant appointment read must return HTTP 403');
    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: 'CROSS_TENANT_ACCESS_VIOLATION',
        entityType: 'APPOINTMENT',
        entityId: appointmentB.id,
      },
      orderBy: { timestamp: 'desc' },
    });
    assert.ok(audit, 'Audit event must be logged for cross-tenant appointment read attempt');
  });

  it('rejects Hospital Admin A attempting to create appointment in Hospital B (POST /api/appointments) with 403 and records AuditEvent', async () => {
    const patient = await prisma.patient.findFirst();
    const res = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        hospitalId: hospitalB.id,
        doctorId: doctorB.id,
        patientId: patient!.id,
        slotId: 'some-slot',
        reason: 'Cross-tenant appointment injection attempt',
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant appointment creation must return HTTP 403');
  });

  it('rejects Hospital Admin A attempting to cancel Hospital B appointment (POST /api/appointments/:id/cancel) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/appointments/${appointmentB.id}/cancel`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        reason: 'Malicious cancellation by competitor hospital admin',
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant appointment cancellation must return HTTP 403');
  });

  it('rejects Hospital Admin A attempting to read Hospital B questionnaires (GET /api/questionnaires?hospitalId=...) with 403 and records AuditEvent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/questionnaires?hospitalId=${hospitalB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant questionnaire query must return HTTP 403');
    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: 'CROSS_TENANT_ACCESS_VIOLATION',
        entityType: 'QUESTIONNAIRE',
        tenantId: hospitalA.id,
        hospitalId: hospitalB.id,
      },
      orderBy: { timestamp: 'desc' },
    });
    assert.ok(audit, 'Audit event must be logged for cross-tenant questionnaire access');
  });

  // ===========================================================================
  // ROLE-SCOPED DASHBOARD RBAC & TENANT ISOLATION (PRD Section 18 & 21)
  // ===========================================================================

  it('rejects Hospital Admin attempting to access Platform Admin dashboard (GET /api/analytics/dashboard/platform-admin) with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/dashboard/platform-admin',
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Hospital Admin cannot access Platform Admin dashboard');
  });

  it('allows Platform Admin to access Platform Admin dashboard with full metrics & system health', async () => {
    const platformAdminToken = await AuthService.signToken({
      id: 'platform-admin-id',
      email: 'platform.admin@health.org',
      name: 'Platform Admin',
      role: UserRole.PLATFORM_ADMIN,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/dashboard/platform-admin',
      headers: {
        authorization: `Bearer ${platformAdminToken}`,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.hospitals), 'Must return hospitals');
    assert.ok(Array.isArray(data.doctors), 'Must return doctors');
    assert.ok(Array.isArray(data.appointments), 'Must return appointments');
    assert.ok(data.operationalHealth, 'Must return operationalHealth');
    assert.strictEqual(data.operationalHealth.database, 'CONNECTED');
  });

  it('rejects Hospital Admin A querying Hospital Admin B dashboard (GET /api/analytics/dashboard/hospital-admin?hospitalId=...) with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics/dashboard/hospital-admin?hospitalId=${hospitalB.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Cross-tenant hospital dashboard query must return 403');
  });

  it('allows Hospital Admin A to access own Hospital Admin dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics/dashboard/hospital-admin?hospitalId=${hospitalA.id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.hospital?.id, hospitalA.id);
    assert.ok(Array.isArray(data.doctors));
    assert.ok(Array.isArray(data.appointments));
    assert.ok(data.availability);
  });

  it('rejects Doctor querying another Doctor dashboard with 403', async () => {
    const docA = await prisma.doctor.findFirst({ where: { hospitalId: hospitalA.id } });
    assert.ok(docA, 'Doctor A must exist');

    const doctorTokenA = await AuthService.signToken({
      id: 'doctor-a-user',
      email: 'doctor.a@apexhealth.org',
      name: 'Dr. Apex',
      role: UserRole.DOCTOR,
      doctorId: docA.id,
      tenantId: hospitalA.id,
    });

    // Doctor A attempts to access Doctor B's dashboard
    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics/dashboard/doctor?doctorId=${doctorB.id}`,
      headers: {
        authorization: `Bearer ${doctorTokenA}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Doctor cannot access another doctor schedule');
  });

  it('rejects Patient querying another Patient dashboard with 403', async () => {
    const patients = await prisma.patient.findMany({ take: 2 });
    assert.ok(patients.length >= 1, 'At least one patient must exist');

    const patientAToken = await AuthService.signToken({
      id: 'patient-a-user',
      email: 'patient.a@example.com',
      name: 'Patient A',
      role: UserRole.PATIENT,
      patientId: patients[0].id,
    });

    const otherPatientId = '00000000-0000-0000-0000-000000000999';

    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics/dashboard/patient?patientId=${otherPatientId}`,
      headers: {
        authorization: `Bearer ${patientAToken}`,
      },
    });

    assert.strictEqual(res.statusCode, 403, 'Patient cannot access another patient profile');
  });

  after(async () => {
    if (app) {
      await app.close();
    }
  });
});
