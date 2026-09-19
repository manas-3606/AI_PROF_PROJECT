import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import { prisma } from '@health/db';
import { MockEhrConnector, IdentifierMapper } from '@health/integration';

describe('Section 4: EHR Integration (PRD Section 12)', () => {
  let ehrServer: FastifyInstance | null = null;
  const ehrPort = 4050; // Distinct port to avoid any collisions
  const baseUrl = `http://localhost:${ehrPort}`;
  let connector: MockEhrConnector;

  let testHospitalId: string;
  const testPatientInternalId = crypto.randomUUID();
  const testDoctorInternalId = crypto.randomUUID();
  const testAppointmentInternalId = crypto.randomUUID();

  const ehrAppointments = new Map<string, any>();
  const ehrProviders = [
    { id: 'EXT-DOC-RAO-01', name: 'Dr. Arvind Rao', specialty: 'Orthopedics' },
    { id: 'EXT-DOC-PATEL-02', name: 'Dr. Maya Patel', specialty: 'Cardiology' },
  ];
  const ehrPatients = [
    { externalPatientId: 'EXT-PAT-DOE-99', name: 'John Doe', phone: '+1-555-0199', dob: '1988-04-12' },
  ];
  const ehrFacilities = [
    { id: 'EXT-FAC-APEX-01', name: 'Apex Health Center', address: '123 Medical Center Way' },
    { id: 'EXT-FAC-METRO-02', name: 'Metro General Hospital', address: '456 Healthcare Blvd' },
  ];

  before(async () => {
    // 1. Start dedicated EHR Server for this integration test
    ehrServer = Fastify({ logger: false });
    await ehrServer.register(cors);

    ehrServer.get('/health', async () => ({ status: 'UP', service: 'mock-ehr' }));

    ehrServer.get('/api/patients', async (req: any, reply: any) => {
      const { phone, externalPatientId } = req.query as any;
      const patient = ehrPatients.find(
        (p) => (phone && p.phone === phone) || (externalPatientId && p.externalPatientId === externalPatientId)
      );
      if (!patient) return reply.status(404).send({ error: 'Patient not found' });
      return patient;
    });

    ehrServer.get('/api/providers', async (req: any) => {
      const { id, name } = req.query as any;
      if (id) return ehrProviders.find((p) => p.id === id) || null;
      if (name) return ehrProviders.find((p) => p.name.toLowerCase().includes(name.toLowerCase())) || null;
      return ehrProviders;
    });

    ehrServer.get('/api/facilities', async (req: any) => {
      const { id, name } = req.query as any;
      if (id) return ehrFacilities.find((f) => f.id === id) || null;
      if (name) return ehrFacilities.find((f) => f.name.toLowerCase().includes(name.toLowerCase())) || null;
      return ehrFacilities;
    });

    ehrServer.get('/api/availability', async (req: any) => {
      const { providerId, startDate } = req.query as any;
      const base = startDate ? new Date(startDate) : new Date();
      return [
        {
          startTime: new Date(base.getTime() + 3600000).toISOString(),
          endTime: new Date(base.getTime() + 5400000).toISOString(),
          available: true,
        },
      ];
    });

    ehrServer.post('/api/appointments', async (req: any, reply: any) => {
      const extId = `EXT-EHR-APPT-${crypto.randomUUID().slice(0, 8)}`;
      const appt = {
        id: extId,
        ...req.body,
        status: 'CONFIRMED',
        verified: true,
        createdAt: new Date().toISOString(),
      };
      ehrAppointments.set(extId, appt);
      ehrAppointments.set(req.body.internalAppointmentId, appt);
      return reply.status(201).send(appt);
    });

    ehrServer.get('/api/appointments/:id', async (req: any, reply: any) => {
      const appt = ehrAppointments.get(req.params.id);
      if (!appt) return reply.status(404).send({ error: 'not found' });
      return appt;
    });

    ehrServer.get('/api/appointments/query', async (req: any, reply: any) => {
      const appt = ehrAppointments.get(req.query.internalId);
      if (!appt) return reply.status(404).send({ error: 'not found' });
      return appt;
    });

    ehrServer.put('/api/appointments/:id', async (req: any, reply: any) => {
      const appt = ehrAppointments.get(req.params.id);
      if (!appt) return reply.status(404).send({ error: 'not found' });
      const updated = { ...appt, ...req.body };
      ehrAppointments.set(req.params.id, updated);
      return updated;
    });

    ehrServer.post('/api/appointments/:id/reschedule', async (req: any, reply: any) => {
      const appt = ehrAppointments.get(req.params.id);
      if (!appt) return reply.status(404).send({ error: 'not found' });
      appt.startTime = req.body.newStartTime;
      appt.endTime = req.body.newEndTime;
      return appt;
    });

    ehrServer.delete('/api/appointments/:id', async (req: any) => {
      const existed = ehrAppointments.delete(req.params.id);
      return { success: existed };
    });

    await ehrServer.listen({ port: ehrPort, host: '127.0.0.1' });
    connector = new MockEhrConnector(baseUrl);

    const hospital = await prisma.hospital.findFirst();
    if (!hospital) throw new Error('No hospital in DB');
    testHospitalId = hospital.id;

    // Clean up any test mappings
    await prisma.externalIdentifierMapping.deleteMany({
      where: { hospitalId: testHospitalId },
    });
  });

  after(async () => {
    if (ehrServer) {
      await ehrServer.close();
    }
    await prisma.externalIdentifierMapping.deleteMany({
      where: { hospitalId: testHospitalId },
    });
  });

  it('1. Patient Lookup: finds patient by phone and by external patient ID, returns null for non-existent', async () => {
    const byPhone = await connector.lookupPatient({ phone: '+1-555-0199' });
    assert.ok(byPhone, 'Should find patient by phone');
    assert.strictEqual(byPhone.name, 'John Doe');
    assert.strictEqual(byPhone.externalPatientId, 'EXT-PAT-DOE-99');

    const byId = await connector.lookupPatient({ externalPatientId: 'EXT-PAT-DOE-99' });
    assert.ok(byId, 'Should find patient by external ID');
    assert.strictEqual(byId.name, 'John Doe');

    const notFound = await connector.lookupPatient({ phone: '+1-000-0000' });
    assert.strictEqual(notFound, null, 'Non-existent patient should return null');
  });

  it('2. Provider Lookup: retrieves external provider by ID or by name', async () => {
    const byId = await connector.lookupProvider({ externalProviderId: 'EXT-DOC-RAO-01' });
    assert.ok(byId, 'Should find provider by ID');
    assert.strictEqual(byId.name, 'Dr. Arvind Rao');
    assert.strictEqual(byId.specialty, 'Orthopedics');

    const byName = await connector.lookupProvider({ name: 'Patel' });
    assert.ok(byName, 'Should find provider by name substring');
    assert.strictEqual(byName.name, 'Dr. Maya Patel');

    const notFound = await connector.lookupProvider({ name: 'NonExistentDoc' });
    assert.strictEqual(notFound, null, 'Unknown provider should return null');
  });

  it('3. Facility Lookup: retrieves facility by ID or name', async () => {
    const byId = await connector.lookupFacility({ externalFacilityId: 'EXT-FAC-APEX-01' });
    assert.ok(byId, 'Should find facility by ID');
    assert.strictEqual(byId.name, 'Apex Health Center');

    const byName = await connector.lookupFacility({ name: 'Metro' });
    assert.ok(byName, 'Should find facility by name');
    assert.strictEqual(byName.name, 'Metro General Hospital');
  });

  it('4. Availability Lookup: queries provider schedules in EHR', async () => {
    const slots = await connector.lookupAvailability('EXT-DOC-RAO-01', '2026-10-01', '2026-10-02');
    assert.ok(Array.isArray(slots), 'Should return an array of slots');
    assert.ok(slots.length > 0, 'Should have at least 1 slot');
    assert.strictEqual(slots[0].available, true);
  });

  let createdExternalApptId: string;

  it('5. Create Appointment: pushes booking to EHR and returns verified external ID', async () => {
    const payload = {
      internalAppointmentId: testAppointmentInternalId,
      externalPatientId: 'EXT-PAT-DOE-99',
      externalProviderId: 'EXT-DOC-RAO-01',
      startTime: '2026-10-01T09:00:00Z',
      endTime: '2026-10-01T09:30:00Z',
      reason: 'Shoulder Consultation',
    };

    const result = await connector.createAppointment(payload);
    assert.ok(result.externalAppointmentId, 'Should return external appointment ID');
    assert.strictEqual(result.status, 'CONFIRMED');
    assert.strictEqual(result.verified, true);
    createdExternalApptId = result.externalAppointmentId;
  });

  it('6. Retrieve Appointment: fetches external appointment record by ID', async () => {
    const retrieved = await connector.getAppointment(createdExternalApptId);
    assert.ok(retrieved, 'Should retrieve external appointment');
    assert.strictEqual(retrieved.externalAppointmentId, createdExternalApptId);
    assert.strictEqual(retrieved.status, 'CONFIRMED');

    // Also verify alias retrieveAppointment
    const aliasRetrieved = await connector.retrieveAppointment!(createdExternalApptId);
    assert.ok(aliasRetrieved, 'retrieveAppointment alias works');
    assert.strictEqual(aliasRetrieved.externalAppointmentId, createdExternalApptId);
  });

  it('7. Update Appointment: updates fields in the external appointment', async () => {
    const updated = await connector.updateAppointment!(createdExternalApptId, {
      reason: 'Updated Shoulder Examination & Imaging',
    });
    assert.strictEqual(updated.status, 'CONFIRMED');

    const fresh = await connector.getAppointment(createdExternalApptId);
    assert.ok(fresh, 'Should retrieve after update');
  });

  it('8. Reschedule Appointment: updates time in EHR with verification', async () => {
    const rescheduleResult = await connector.rescheduleAppointment({
      internalAppointmentId: testAppointmentInternalId,
      externalAppointmentId: createdExternalApptId,
      newStartTime: '2026-10-02T10:00:00Z',
      newEndTime: '2026-10-02T10:30:00Z',
      reason: 'Rescheduled upon patient request',
    });

    assert.strictEqual(rescheduleResult.status, 'CONFIRMED');
    assert.strictEqual(rescheduleResult.verified, true);

    const checkEhr = await connector.getAppointment(createdExternalApptId);
    assert.ok(checkEhr);
  });

  it('9. Verify Appointment: verifies appointment exists and matches internal record', async () => {
    const verification = await connector.verifyAppointment(
      testAppointmentInternalId,
      createdExternalApptId
    );
    assert.strictEqual(verification.isVerified, true);
    assert.strictEqual(verification.match, true);
    assert.strictEqual(verification.externalStatus, 'CONFIRMED');

    const nonExistent = await connector.verifyAppointment('non-existent-id', 'EXT-DOES-NOT-EXIST');
    assert.strictEqual(nonExistent.isVerified, false);
    assert.strictEqual(nonExistent.match, false);
  });

  it('10. Cancel Appointment: cancels appointment in EHR and confirms subsequent lookup fails', async () => {
    const cancelled = await connector.cancelAppointment(createdExternalApptId);
    assert.strictEqual(cancelled, true, 'cancelAppointment should return true');

    const checkGone = await connector.getAppointment(createdExternalApptId);
    assert.strictEqual(checkGone, null, 'Deleted appointment should return null from EHR');
  });

  it('11. Two-Way Identifier Mappings: sets and resolves PATIENT, DOCTOR, FACILITY, APPOINTMENT mappings bidirectionally', async () => {
    // Set mappings
    await IdentifierMapper.setMapping(testHospitalId, 'PATIENT', testPatientInternalId, 'EXT-PAT-DOE-99');
    await IdentifierMapper.setMapping(testHospitalId, 'DOCTOR', testDoctorInternalId, 'EXT-DOC-RAO-01');
    await IdentifierMapper.setMapping(testHospitalId, 'FACILITY', testHospitalId, 'EXT-FAC-APEX-01');
    await IdentifierMapper.setMapping(testHospitalId, 'APPOINTMENT', testAppointmentInternalId, 'EXT-APPT-999');

    // Test getExternalId (Internal -> External)
    const extPatient = await IdentifierMapper.getExternalId(testHospitalId, 'PATIENT', testPatientInternalId);
    assert.strictEqual(extPatient, 'EXT-PAT-DOE-99');

    const extDoc = await IdentifierMapper.getExternalId(testHospitalId, 'DOCTOR', testDoctorInternalId);
    assert.strictEqual(extDoc, 'EXT-DOC-RAO-01');

    const extFac = await IdentifierMapper.getExternalId(testHospitalId, 'FACILITY', testHospitalId);
    assert.strictEqual(extFac, 'EXT-FAC-APEX-01');

    const extAppt = await IdentifierMapper.getExternalId(testHospitalId, 'APPOINTMENT', testAppointmentInternalId);
    assert.strictEqual(extAppt, 'EXT-APPT-999');

    // Test getInternalId (External -> Internal)
    const intPatient = await IdentifierMapper.getInternalId(testHospitalId, 'PATIENT', 'EXT-PAT-DOE-99');
    assert.strictEqual(intPatient, testPatientInternalId);

    const intDoc = await IdentifierMapper.getInternalId(testHospitalId, 'DOCTOR', 'EXT-DOC-RAO-01');
    assert.strictEqual(intDoc, testDoctorInternalId);

    const intFac = await IdentifierMapper.getInternalId(testHospitalId, 'FACILITY', 'EXT-FAC-APEX-01');
    assert.strictEqual(intFac, testHospitalId);

    const intAppt = await IdentifierMapper.getInternalId(testHospitalId, 'APPOINTMENT', 'EXT-APPT-999');
    assert.strictEqual(intAppt, testAppointmentInternalId);

    // Verify database record count
    const count = await prisma.externalIdentifierMapping.count({
      where: { hospitalId: testHospitalId },
    });
    assert.strictEqual(count, 4, 'Should have exactly 4 mappings in the database');
  });
});
