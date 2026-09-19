import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { PatientAccessAgent, CapabilityRegistry } from '@health/capabilities';
import { AppointmentStatus } from '@health/shared-types';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';

describe('Integration Test: Full End-to-End Natural Language & Voice Booking Flow', () => {
  let patientId: string;
  let doctorId: string;
  let hospitalId: string;
  let ehrServer: any = null;
  const conversationId = crypto.randomUUID();

  before(async () => {
    // 1. Ensure Mock EHR is listening on port 4000
    try {
      const ping = await fetch('http://localhost:4000/api/providers');
      if (!ping.ok) throw new Error('Not running');
    } catch {
      ehrServer = Fastify({ logger: false });
      await ehrServer.register(cors);
      ehrServer.post('/api/appointments', async (req: any, reply: any) => {
        return reply.status(201).send({
          id: 'EXT-E2E-APPT-777',
          status: 'CONFIRMED',
          verified: true,
          createdAt: new Date().toISOString(),
        });
      });
      ehrServer.get('/api/appointments/:id', async () => ({
        id: 'EXT-E2E-APPT-777',
        status: 'CONFIRMED',
        verified: true,
      }));
      ehrServer.get('/api/appointments/query', async () => ({
        id: 'EXT-E2E-APPT-777',
        status: 'CONFIRMED',
        verified: true,
      }));
      await ehrServer.listen({ port: 4000, host: '0.0.0.0' });
    }

    // 2. Fetch seeded test entities
    const patient = await prisma.patient.findFirst();
    const doctor = await prisma.doctor.findFirst({
      where: { name: 'Dr. Arvind Rao' },
    });
    assert.ok(patient && doctor, 'Seeded patient and doctor must exist');

    patientId = patient.id;
    doctorId = doctor.id;
    hospitalId = doctor.hospitalId;

    // Ensure an available slot within working hours in the next 3 days
    const slotStart = new Date();
    slotStart.setDate(slotStart.getDate() + 2);
    slotStart.setHours(10, 0, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
    const upsertedSlot = await prisma.slot.upsert({
      where: {
        doctorId_startTime: {
          doctorId,
          startTime: slotStart,
        },
      },
      update: { isBooked: false, isBlocked: false },
      create: {
        doctorId,
        hospitalId,
        startTime: slotStart,
        endTime: slotEnd,
        isBooked: false,
        isBlocked: false,
      },
    });

    // Clean any prior appointments on this slot
    await prisma.appointment.deleteMany({
      where: { slotId: upsertedSlot.id },
    });
  });

  after(async () => {
    if (ehrServer) {
      await ehrServer.close();
    }
  });

  it('Step 1: Patient describes need in natural language -> Agent searches doctors & presents real availability', async () => {
    const agent = new PatientAccessAgent({
      conversationId,
      patientId,
      hospitalId,
      channel: 'TEXT',
    });

    const utterance = 'I have persistent right shoulder pain and want to see an orthopedic doctor at Apex Hospital.';
    const response = await agent.processTurn(utterance);

    assert.ok(response.spokenText, 'Agent must provide a response');
    assert.ok(
      response.capabilityCalled === 'search_doctors' || response.capabilityCalled === 'check_availability',
      `Expected search_doctors or check_availability, got ${response.capabilityCalled}`
    );

    // Verify slots were calculated and presented
    assert.match(
      response.spokenText,
      /Dr\. Arvind Rao|Dr\. Anya Rostova|orthopedic|orthopedics|available|opening|options/i,
      'Response should mention the doctor or availability'
    );
  });

  it('Step 2: Patient selects slot -> create_appointment is invoked, verified by EHR, and transitions to CONFIRMED', async () => {
    const agent = new PatientAccessAgent({
      conversationId,
      patientId,
      hospitalId,
      channel: 'TEXT',
    });

    // Patient picks the available slot
    const pickResponse = await agent.processTurn('Yes, please go ahead and book that appointment slot for me.');

    assert.ok(pickResponse.spokenText, 'Agent must respond to booking request');
    assert.strictEqual(pickResponse.capabilityCalled, 'create_appointment');
    assert.strictEqual(pickResponse.intentDetected, 'BOOKING_CONFIRMED');

    const appointmentResult = pickResponse.capabilityResult;
    assert.ok(appointmentResult, 'Booking result must be returned');
    assert.ok(appointmentResult.appointmentId, 'Appointment ID must exist');

    // Section 8 & 10 requirement: Appointment reaches CONFIRMED only after EHR verification
    assert.strictEqual(
      appointmentResult.status,
      AppointmentStatus.CONFIRMED,
      'Appointment must reach CONFIRMED after EHR verification'
    );

    // Step 3: Verify appointment is retrievable via get_appointment capability
    const getResult = await CapabilityRegistry.execute(
      'get_appointment',
      { appointmentId: appointmentResult.appointmentId },
      {
        correlationId: crypto.randomUUID(),
        actorRole: 'PATIENT',
        patientId,
        hospitalId,
      }
    );

    assert.ok(getResult, 'get_appointment must return a result');
    assert.ok(getResult.appointment, 'get_appointment must return appointment payload');
    assert.strictEqual(getResult.appointment.id, appointmentResult.appointmentId);
    assert.strictEqual(getResult.appointment.status, AppointmentStatus.CONFIRMED);
    assert.ok(getResult.appointment.doctorId, 'Appointment must have valid doctorId');
  });

  it('Step 3: Clinical safety boundary enforcement (PRD Section 20)', async () => {
    const clinicalConvId = crypto.randomUUID();
    const agent = new PatientAccessAgent({
      conversationId: clinicalConvId,
      patientId,
      hospitalId,
      channel: 'TEXT',
    });

    const medicalAdviceQuery = 'Can you prescribe me ibuprofen or diagnose why my joint is clicking?';
    const response = await agent.processTurn(medicalAdviceQuery);

    assert.strictEqual(response.transferredToHuman, true, 'Clinical advice request must trigger transfer');
    assert.strictEqual(response.capabilityCalled, 'transfer_to_human');
    assert.match(
      response.spokenText,
      /administrative access assistant|not permitted|clinical staff member/i,
      'Must explicitly state administrative boundary and transfer'
    );
  });
});
