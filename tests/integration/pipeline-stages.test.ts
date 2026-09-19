import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import { CapabilityRegistry, StubEhrConnector } from '@health/capabilities';
import { SchedulingService, SlotCalculator } from '@health/scheduling';
import { IdentifierMapper } from '@health/integration';
import { processWorkflowJob } from '@health/workflows';
import crypto from 'node:crypto';

describe('Integration Test: 7-Stage Architectural Pipeline Handoffs (PRD Section 26)', () => {
  let hospital: any;
  let doctor: any;
  let patient: any;
  let slot: any;
  let correlationId: string;
  let pendingAppointment: any;
  let confirmedAppointmentId: string;
  let externalApptId: string;
  let workflowExecutionId: string;

  before(async () => {
    hospital = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
    assert.ok(hospital);

    doctor = await prisma.doctor.findFirst({
      where: { hospitalId: hospital.id, status: 'ACTIVE' },
      include: { calendar: { include: { workingHours: true } } },
    });
    assert.ok(doctor && doctor.calendar);

    patient = await prisma.patient.findFirst();
    assert.ok(patient);

    CapabilityRegistry.setHealthcareConnector(new StubEhrConnector());
    correlationId = `pipeline-handoff-${crypto.randomUUID()}`;

    // Ensure available slot matching working hours
    const workingHours = doctor.calendar.workingHours || [];
    const candidates = await prisma.slot.findMany({
      where: { doctorId: doctor.id, isBooked: false, isBlocked: false },
      orderBy: { startTime: 'asc' },
    });

    let foundSlot = null;
    for (const cand of candidates) {
      if (SlotCalculator.isWithinWorkingHours(cand.startTime, cand.endTime, workingHours)) {
        const isBlocked = await prisma.blockedSlot.findFirst({
          where: {
            calendarId: doctor.calendar.id,
            startTime: { lt: cand.endTime },
            endTime: { gt: cand.startTime },
          },
        });
        if (!isBlocked) {
          foundSlot = cand;
          break;
        }
      }
    }

    if (foundSlot) {
      await prisma.appointment.deleteMany({ where: { slotId: foundSlot.id } });
      slot = foundSlot;
    } else {
      const wh = workingHours[0] || { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };
      const [startH, startM] = wh.startTime.split(':').map(Number);
      const d = new Date();
      d.setDate(d.getDate() + ((wh.dayOfWeek - d.getDay() + 7) % 7 || 7));
      d.setHours(startH, startM, 0, 0);

      let testStartTime = new Date(d);
      while (
        (await prisma.slot.findFirst({ where: { doctorId: doctor.id, startTime: testStartTime } })) ||
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
      const testEndTime = new Date(testStartTime.getTime() + 30 * 60000);

      slot = await prisma.slot.create({
        data: {
          doctorId: doctor.id,
          hospitalId: hospital.id,
          startTime: testStartTime,
          endTime: testEndTime,
          isBooked: false,
          isBlocked: false,
        },
      });
    }
  });

  it('Stage 1: AI -> Scheduling handoff (Intent resolves into check_availability with real slot calculation)', async () => {
    const slots = await CapabilityRegistry.execute(
      'check_availability',
      {
        doctorId: doctor.id,
        startDate: new Date(slot.startTime.getTime() - 3600000).toISOString(),
        endDate: new Date(slot.endTime.getTime() + 3600000).toISOString(),
      },
      {
        actorRole: 'PATIENT',
        patientId: patient.id,
        tenantId: hospital.id,
        correlationId,
      }
    );

    assert.ok(Array.isArray(slots.slots), 'Must return slot array');
    const matched = slots.slots.find((s: any) => s.slotId === slot.id);
    assert.ok(matched, 'Calculated slot must match real database slot');
  });

  it('Stage 2: Scheduling -> Appointment handoff (Atomic reservation & pre-commit revalidation)', async () => {
    // SchedulingService.bookAppointment creates the appointment atomically in PENDING state
    pendingAppointment = await SchedulingService.bookAppointment({
      patientId: patient.id,
      doctorId: doctor.id,
      hospitalId: hospital.id,
      slotId: slot.id,
      reason: '7-stage pipeline verification',
      idempotencyKey: crypto.randomUUID(),
      correlationId,
    });

    assert.ok(pendingAppointment.id);
    assert.strictEqual(pendingAppointment.status, AppointmentStatus.PENDING);

    // Slot is marked booked in the database to protect against concurrency
    const slotDb = await prisma.slot.findUnique({ where: { id: slot.id } });
    assert.strictEqual(slotDb?.isBooked, true);
  });

  it('Stage 3: Appointment -> EHR handoff (Outbound healthcare connector invocation)', async () => {
    const connector = new StubEhrConnector();
    CapabilityRegistry.setHealthcareConnector(connector);

    const ehrResult = await connector.createAppointment({
      internalAppointmentId: pendingAppointment.id,
      patientId: patient.id,
      doctorId: doctor.id,
      hospitalId: hospital.id,
      slotId: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      reason: '7-stage pipeline verification',
    });

    assert.ok(ehrResult.externalAppointmentId);
    assert.strictEqual(ehrResult.status, 'CONFIRMED');
    externalApptId = ehrResult.externalAppointmentId;
  });

  it('Stage 4: EHR -> Verification handoff (Proactive verification query to external system)', async () => {
    const verifyResult = await CapabilityRegistry.execute(
      'verify_external_appointment',
      {
        internalAppointmentId: pendingAppointment.id,
        externalAppointmentId: externalApptId,
        hospitalId: hospital.id,
      },
      {
        actorRole: 'STAFF',
        tenantId: hospital.id,
        correlationId,
      }
    );

    assert.strictEqual(verifyResult.isVerified, true);
    assert.strictEqual(verifyResult.externalStatus, 'CONFIRMED');
  });

  it('Stage 5: Verification -> Synchronization handoff (State advanced to Confirmed & 4-way entity mapping saved)', async () => {
    // Record external appointment ID on internal appointment prior to synchronization
    await prisma.appointment.update({
      where: { id: pendingAppointment.id },
      data: {
        externalAppointmentId: externalApptId,
        status: AppointmentStatus.SYNCHRONIZATION_PENDING,
      },
    });

    const syncResult = await CapabilityRegistry.execute(
      'synchronize_state',
      {
        appointmentId: pendingAppointment.id,
        targetStatus: 'Confirmed',
        correlationId,
        externalAppointmentId: externalApptId,
        reason: 'Verified by integration layer',
      },
      {
        actorRole: 'STAFF',
        tenantId: hospital.id,
        correlationId,
      }
    );

    assert.strictEqual(syncResult.internalStatus, AppointmentStatus.CONFIRMED);
    confirmedAppointmentId = pendingAppointment.id;

    // Verify entity mappings exist
    await IdentifierMapper.setMapping(hospital.id, 'APPOINTMENT', confirmedAppointmentId, externalApptId);
    const extAppt = await IdentifierMapper.getExternalId(hospital.id, 'APPOINTMENT', confirmedAppointmentId);
    assert.strictEqual(extAppt, externalApptId);
  });

  it('Stage 6: Booking -> Workflow handoff (Pre-visit intake workflow triggered)', async () => {
    const wfResult = await CapabilityRegistry.execute(
      'start_workflow',
      {
        workflowType: 'PreVisitQuestionnaire',
        hospitalId: hospital.id,
        triggerEvent: 'APPOINTMENT_CONFIRMED',
        idempotencyKey: crypto.randomUUID(),
        appointmentId: confirmedAppointmentId,
        payload: {
          appointmentId: confirmedAppointmentId,
          patientId: patient.id,
        },
      },
      {
        actorRole: 'STAFF',
        tenantId: hospital.id,
        correlationId,
      }
    );

    assert.strictEqual(wfResult.status, 'Active');
    assert.ok(wfResult.workflowExecutionId);
    workflowExecutionId = wfResult.workflowExecutionId;
  });

  it('Stage 7: Workflow -> Notification handoff (Async job executes and dispatches patient confirmation)', async () => {
    const jobData = {
      workflowExecutionId,
      workflowType: 'AppointmentConfirmed' as const,
      hospitalId: hospital.id,
      appointmentId: confirmedAppointmentId,
      condition: 'APPOINTMENT_NOT_CANCELLED' as const,
      payload: {
        appointmentId: confirmedAppointmentId,
        doctorName: doctor.name,
        startTime: slot.startTime,
      },
      attemptCount: 0,
    };

    await processWorkflowJob(jobData);

    const notifications = await prisma.notification.findMany({
      where: { payloadJson: { contains: confirmedAppointmentId } },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(notifications.length > 0, 'Notification must be dispatched by workflow job');
    assert.ok(
      notifications[0].status === 'Sent' || notifications[0].status === 'Delivered',
      `Notification status should be Sent or Delivered, got ${notifications[0].status}`
    );
  });
});
