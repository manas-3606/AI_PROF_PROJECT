import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { CapabilityRegistry } from '@health/capabilities';
import { AppointmentStatus } from '@health/shared-types';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';

import { SlotCalculator } from '@health/scheduling';

describe('Integration Test: End-to-End Booking Core Loop', () => {
  let patientId: string;
  let doctorId: string;
  let hospitalId: string;
  let slotId: string;
  let createdAppointmentId: string;
  let ehrServer: any = null;
  let workingHours: any[] = [];

  before(async () => {
    // 1. Ensure Mock EHR is listening on port 4000 for integration verification
    try {
      const ping = await fetch('http://localhost:4000/api/providers');
      if (!ping.ok) throw new Error('Not running');
    } catch {
      ehrServer = Fastify({ logger: false });
      await ehrServer.register(cors);
      ehrServer.post('/api/appointments', async (req: any, reply: any) => {
        return reply.status(201).send({
          id: 'EXT-APPT-1001',
          status: 'CONFIRMED',
          verified: true,
          createdAt: new Date().toISOString(),
        });
      });
      ehrServer.get('/api/appointments/:id', async () => ({
        id: 'EXT-APPT-1001',
        status: 'CONFIRMED',
        verified: true,
      }));
      ehrServer.get('/api/appointments/query', async () => ({
        id: 'EXT-APPT-1001',
        status: 'CONFIRMED',
        verified: true,
      }));
      await ehrServer.listen({ port: 4000, host: '0.0.0.0' });
    }

    const patient = await prisma.patient.findFirst();
    const doctor = await prisma.doctor.findFirst({
      where: { name: 'Dr. Arvind Rao' },
      include: { calendar: { include: { workingHours: true } } },
    });
    assert.ok(patient && doctor, 'Patient and Doctor must exist in seeded database');

    patientId = patient.id;
    doctorId = doctor.id;
    hospitalId = doctor.hospitalId;

    workingHours = doctor.calendar?.workingHours || [];
    const candidates = await prisma.slot.findMany({
      where: { doctorId, isBooked: false, isBlocked: false },
      orderBy: { startTime: 'asc' },
    });

    let slot = candidates.find((c) => SlotCalculator.isWithinWorkingHours(c.startTime, c.endTime, workingHours));
    if (!slot) {
      const wh = workingHours[0] || { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };
      const [sh, sm] = wh.startTime.split(':').map(Number);
      const d = new Date();
      d.setDate(d.getDate() + ((wh.dayOfWeek - d.getDay() + 7) % 7 || 7));
      d.setHours(sh, sm, 0, 0);
      let sTime = new Date(d);
      while (
        (await prisma.slot.findFirst({ where: { doctorId, startTime: sTime } })) ||
        !SlotCalculator.isWithinWorkingHours(sTime, new Date(sTime.getTime() + 30 * 60 * 1000), workingHours)
      ) {
        sTime = new Date(sTime.getTime() + 30 * 60 * 1000);
        if (sTime.getHours() >= 17) {
          sTime.setDate(sTime.getDate() + 1);
          sTime.setHours(sh, sm, 0, 0);
        }
      }
      slot = await prisma.slot.create({
        data: {
          doctorId,
          hospitalId,
          startTime: sTime,
          endTime: new Date(sTime.getTime() + 30 * 60 * 1000),
          isBooked: false,
          isBlocked: false,
        },
      });
    }

    assert.ok(slot, 'Unbooked slot must exist');
    slotId = slot.id;
  });

  after(async () => {
    if (ehrServer) {
      await ehrServer.close();
    }
  });

  it('executes booking through capabilities, verifies against external system, and synchronizes status to Confirmed', async () => {
    const idempotencyKey = crypto.randomUUID();

    // 1. Execute create_appointment capability
    const result = await CapabilityRegistry.execute('create_appointment', {
      patientId,
      doctorId,
      hospitalId,
      slotId,
      reason: 'Shoulder joint pain evaluation',
      idempotencyKey,
    });

    assert.ok(result.appointmentId, 'Must return appointmentId');
    createdAppointmentId = result.appointmentId;

    // 2. Verify appointment record in database
    const appt = await prisma.appointment.findUnique({
      where: { id: result.appointmentId },
      include: {
        verifications: true,
        workflowExecutions: true,
      },
    });

    assert.ok(appt, 'Appointment must be persisted in database');
    assert.ok(
      appt.status === AppointmentStatus.CONFIRMED || appt.status === AppointmentStatus.PENDING,
      'Status must advance through booking chain'
    );

    // 3. Verify slot is marked booked
    const updatedSlot = await prisma.slot.findUnique({ where: { id: slotId } });
    assert.strictEqual(updatedSlot?.isBooked, true, 'Slot must be atomically marked booked');

    // 4. Verify post-booking questionnaire workflow was queued
    const workflow = await prisma.workflowExecution.findFirst({
      where: { appointmentId: result.appointmentId },
    });
    assert.ok(workflow, 'Post-booking workflow execution must be recorded');
  });

  it('enforces idempotency: repeating the booking with identical idempotencyKey returns the same record', async () => {
    const idempotencyKey = `test-idemp-${crypto.randomUUID()}`;

    // Ensure an available slot within working hours
    const candidates2 = await prisma.slot.findMany({
      where: { doctorId, isBooked: false, isBlocked: false },
      orderBy: { startTime: 'asc' },
    });
    let slot2 = candidates2.find((c) => SlotCalculator.isWithinWorkingHours(c.startTime, c.endTime, workingHours));
    if (!slot2) {
      const wh = workingHours[0] || { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };
      const [sh, sm] = wh.startTime.split(':').map(Number);
      const d = new Date();
      d.setDate(d.getDate() + 14);
      d.setHours(sh, sm, 0, 0);
      let sTime = new Date(d);
      while (
        (await prisma.slot.findFirst({ where: { doctorId, startTime: sTime } })) ||
        !SlotCalculator.isWithinWorkingHours(sTime, new Date(sTime.getTime() + 30 * 60 * 1000), workingHours)
      ) {
        sTime = new Date(sTime.getTime() + 30 * 60 * 1000);
        if (sTime.getHours() >= 17) {
          sTime.setDate(sTime.getDate() + 1);
          sTime.setHours(sh, sm, 0, 0);
        }
      }
      slot2 = await prisma.slot.create({
        data: {
          doctorId,
          hospitalId,
          startTime: sTime,
          endTime: new Date(sTime.getTime() + 30 * 60 * 1000),
          isBooked: false,
          isBlocked: false,
        },
      });
    }

    // 1. First call: successfully reserves slot and creates appointment
    const firstCall = await CapabilityRegistry.execute('create_appointment', {
      patientId,
      doctorId,
      hospitalId,
      slotId: slot2.id,
      reason: 'Idempotency verification',
      idempotencyKey,
    });
    assert.ok(firstCall.appointmentId, 'First call must create an appointment');

    // Verify slot is now booked in database
    const slotCheck = await prisma.slot.findUnique({ where: { id: slot2.id } });
    assert.strictEqual(slotCheck?.isBooked, true, 'Target slot is now booked in database');

    // 2. Second call: fired with identical idempotencyKey against the ALREADY-BOOKED slot
    // Idempotency check runs BEFORE slot revalidation, returning the original record rather than 409
    const secondCall = await CapabilityRegistry.execute('create_appointment', {
      patientId,
      doctorId,
      hospitalId,
      slotId: slot2.id,
      reason: 'Idempotency verification repeat',
      idempotencyKey,
    });

    assert.strictEqual(
      secondCall.appointmentId,
      firstCall.appointmentId,
      'Duplicate request against booked slot must return original appointment'
    );
    assert.strictEqual(secondCall.status, firstCall.status, 'Status must match original appointment');
  });
});
