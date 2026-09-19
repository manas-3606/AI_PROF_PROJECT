import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import {
  ConcurrencyLockManager,
  SchedulingService,
  SlotAlreadyBookedError,
  SlotNoLongerAvailableError,
} from '@health/scheduling';

describe('Unit Test: Concurrency Lock & Double-Booking Prevention (PRD Section 7)', () => {
  let testDoctor: any;
  let testHospital: any;
  let testPatient: any;

  before(async () => {
    testDoctor = await prisma.doctor.findFirst({
      where: { name: 'Dr. Arvind Rao' },
      include: { calendar: true },
    });
    assert.ok(testDoctor, 'Test doctor must exist in database');

    // Ensure doctor is ACTIVE and calendar is active for concurrency tests
    if (testDoctor.status !== 'ACTIVE') {
      testDoctor = await prisma.doctor.update({
        where: { id: testDoctor.id },
        data: { status: 'ACTIVE' },
        include: { calendar: true },
      });
    }

    testHospital = await prisma.hospital.findUnique({
      where: { id: testDoctor.hospitalId },
    });
    assert.ok(testHospital, 'Test hospital must exist in database');

    testPatient = await prisma.patient.findFirst({
      where: { name: 'John Doe' },
    });
    assert.ok(testPatient, 'Test patient must exist in database');
  });

  it('allows only ONE concurrent reservation attempt to succeed and rejects the other (ConcurrencyLockManager)', async () => {
    // 1. Create a dedicated fresh slot for clean concurrency isolation
    const slotStartTime = new Date();
    slotStartTime.setDate(slotStartTime.getDate() + 10);
    slotStartTime.setHours(9, 30, 0, 0);
    const slotEndTime = new Date(slotStartTime);
    slotEndTime.setMinutes(slotStartTime.getMinutes() + 30);

    const slot = await prisma.slot.create({
      data: {
        doctorId: testDoctor.id,
        hospitalId: testHospital.id,
        startTime: slotStartTime,
        endTime: slotEndTime,
        isBooked: false,
        isBlocked: false,
      },
    });

    try {
      // 2. Fire two simultaneous atomic reservation attempts at the exact same slot
      const promise1 = ConcurrencyLockManager.reserveSlotAtomically(slot.id);
      const promise2 = ConcurrencyLockManager.reserveSlotAtomically(slot.id);

      const results = await Promise.allSettled([promise1, promise2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one must succeed
      assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent booking attempt must succeed');
      assert.strictEqual(rejected.length, 1, 'The competing concurrent attempt must be rejected');

      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(
        rejectionReason instanceof SlotAlreadyBookedError ||
          rejectionReason instanceof SlotNoLongerAvailableError ||
          rejectionReason.message.includes('already booked') ||
          rejectionReason.message.includes('no longer available'),
        'Rejection must be a clear slot-no-longer-available error'
      );

      // Verify final state in database
      const finalSlot = await prisma.slot.findUnique({ where: { id: slot.id } });
      assert.strictEqual(finalSlot?.isBooked, true, 'Slot must be marked booked');
    } finally {
      // Cleanup slot
      await prisma.slot.delete({ where: { id: slot.id } });
    }
  });

  it('fires two concurrent booking requests at the same slot via SchedulingService: exactly one succeeds and the other receives a clear slot-no-longer-available error', async () => {
    // 1. Create a dedicated test slot within working hours (09:00 - 09:30 on an upcoming Monday)
    const slotStartTime = new Date();
    slotStartTime.setDate(slotStartTime.getDate() + 14);
    const day = slotStartTime.getDay();
    const diff = (1 - day + 7) % 7;
    slotStartTime.setDate(slotStartTime.getDate() + (diff === 0 ? 7 : diff));
    slotStartTime.setHours(10, 0, 0, 0);

    const slotEndTime = new Date(slotStartTime);
    slotEndTime.setMinutes(slotStartTime.getMinutes() + 30);

    await prisma.slot.deleteMany({ where: { doctorId: testDoctor.id, startTime: slotStartTime } });

    const testSlot = await prisma.slot.create({
      data: {
        doctorId: testDoctor.id,
        hospitalId: testHospital.id,
        startTime: slotStartTime,
        endTime: slotEndTime,
        isBooked: false,
        isBlocked: false,
      },
    });

    try {
      // 2. Fire two simultaneous booking attempts via SchedulingService.bookAppointment
      const bookingAttempt1 = SchedulingService.bookAppointment({
        patientId: testPatient.id,
        doctorId: testDoctor.id,
        hospitalId: testHospital.id,
        slotId: testSlot.id,
        reason: 'Concurrent booking request A (Turn 1)',
        correlationId: 'corr-concurrency-test-1',
      });

      const bookingAttempt2 = SchedulingService.bookAppointment({
        patientId: testPatient.id,
        doctorId: testDoctor.id,
        hospitalId: testHospital.id,
        slotId: testSlot.id,
        reason: 'Concurrent booking request B (Turn 2)',
        correlationId: 'corr-concurrency-test-2',
      });

      const results = await Promise.allSettled([bookingAttempt1, bookingAttempt2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Assert exactly one succeeds
      assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent booking request must succeed');

      // Assert the competing one is rejected with clear error
      assert.strictEqual(rejected.length, 1, 'The competing concurrent request must be rejected');

      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(
        rejectionReason instanceof SlotAlreadyBookedError ||
          rejectionReason instanceof SlotNoLongerAvailableError ||
          rejectionReason.message.includes('already booked') ||
          rejectionReason.message.includes('no longer available'),
        `Rejection error must clearly indicate slot is no longer available. Got: "${rejectionReason?.message}"`
      );

      // Verify DB consistency: exactly one appointment exists for this slot
      const appointments = await prisma.appointment.findMany({
        where: { slotId: testSlot.id },
      });
      assert.strictEqual(appointments.length, 1, 'Database must contain exactly 1 appointment for the contested slot');
      assert.strictEqual(appointments[0].status, AppointmentStatus.PENDING);

      // Verify slot is flagged as booked
      const updatedSlot = await prisma.slot.findUnique({
        where: { id: testSlot.id },
      });
      assert.strictEqual(updatedSlot?.isBooked, true, 'Contested slot must remain booked in database');
    } finally {
      // Cleanup appointments and test slot
      await prisma.appointmentStateHistory.deleteMany({
        where: { appointment: { slotId: testSlot.id } },
      });
      await prisma.appointment.deleteMany({
        where: { slotId: testSlot.id },
      });
      await prisma.slot.delete({
        where: { id: testSlot.id },
      });
    }
  });

  it('revalidates availability immediately before commit as a distinct step, rejecting booking if slot becomes blocked between search and commit', async () => {
    // 1. Create a dedicated test slot within working hours
    const slotStartTime = new Date();
    slotStartTime.setDate(slotStartTime.getDate() + 21);
    const day = slotStartTime.getDay();
    const diff = (1 - day + 7) % 7;
    slotStartTime.setDate(slotStartTime.getDate() + (diff === 0 ? 7 : diff));
    slotStartTime.setHours(11, 0, 0, 0);

    const slotEndTime = new Date(slotStartTime);
    slotEndTime.setMinutes(slotStartTime.getMinutes() + 30);

    const testSlot = await prisma.slot.create({
      data: {
        doctorId: testDoctor.id,
        hospitalId: testHospital.id,
        startTime: slotStartTime,
        endTime: slotEndTime,
        isBooked: false,
        isBlocked: false,
      },
    });

    let blockedPeriodId: string | undefined;
    try {
      // 2. Simulate search phase: verify slot was originally found as available
      const initialSearch = await SchedulingService.getAvailableSlots(
        testDoctor.id,
        new Date(slotStartTime.getTime() - 3600 * 1000),
        new Date(slotEndTime.getTime() + 3600 * 1000)
      );
      assert.ok(
        initialSearch.some((s) => s.id === testSlot.id),
        'Slot must be initially available during search'
      );

      // 3. Intervening event: Doctor calendar enters a blocked period / leave right before booking commit
      const blockedPeriod = await prisma.blockedSlot.create({
        data: {
          calendarId: testDoctor.calendar.id,
          hospitalId: testHospital.id,
          startTime: slotStartTime,
          endTime: slotEndTime,
          reason: 'Emergency Medical Leave',
        },
      });
      blockedPeriodId = blockedPeriod.id;

      // 4. Attempt to book using the slot found in initial search:
      // Pre-commit revalidation MUST detect the intervening blocked period and abort the transaction!
      await assert.rejects(
        async () => {
          await SchedulingService.bookAppointment({
            patientId: testPatient.id,
            doctorId: testDoctor.id,
            hospitalId: testHospital.id,
            slotId: testSlot.id,
            reason: 'Attempt booking slot that was just blocked',
          });
        },
        (err: any) => {
          assert.ok(
            err instanceof SlotNoLongerAvailableError || err.message.includes('no longer available'),
            `Should throw SlotNoLongerAvailableError. Got: ${err.message}`
          );
          assert.ok(
            err.message.includes('blocked period') || err.message.includes('Emergency Medical Leave'),
            `Error message should state reason. Got: ${err.message}`
          );
          return true;
        }
      );

      // Verify no appointment was created
      const appt = await prisma.appointment.findFirst({
        where: { slotId: testSlot.id },
      });
      assert.strictEqual(appt, null, 'No appointment should be persisted when pre-commit revalidation fails');
    } finally {
      if (blockedPeriodId) {
        await prisma.blockedSlot.deleteMany({
          where: { id: blockedPeriodId },
        });
      }
      await prisma.slot.deleteMany({
        where: { id: testSlot.id },
      });
    }
  });
});
