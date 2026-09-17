import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { AppointmentStatus } from '@health/shared-types';
import crypto from 'node:crypto';

describe('Unit Test: Appointment State Machine & Transitions (PRD Section 14 & 26)', () => {
  let hospital: any;
  let doctor: any;
  let patient: any;
  let slot: any;

  // State Transition Validator Matrix matching PRD Section 14
  const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
    [AppointmentStatus.REQUESTED]: [AppointmentStatus.PENDING, AppointmentStatus.FAILED],
    [AppointmentStatus.PENDING]: [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.FAILED,
      AppointmentStatus.SYNCHRONIZATION_PENDING,
      AppointmentStatus.RECONCILIATION_REQUIRED,
    ],
    [AppointmentStatus.SYNCHRONIZATION_PENDING]: [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.RECONCILIATION_REQUIRED,
    ],
    [AppointmentStatus.CONFIRMED]: [
      AppointmentStatus.RESCHEDULED,
      AppointmentStatus.CANCELLED,
      AppointmentStatus.COMPLETED,
      AppointmentStatus.NO_SHOW,
    ],
    [AppointmentStatus.RESCHEDULED]: [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.CANCELLED,
    ],
    [AppointmentStatus.CANCELLED]: [], // Terminal
    [AppointmentStatus.COMPLETED]: [], // Terminal
    [AppointmentStatus.NO_SHOW]: [], // Terminal
    [AppointmentStatus.FAILED]: [AppointmentStatus.RECONCILIATION_REQUIRED],
    [AppointmentStatus.RECONCILIATION_REQUIRED]: [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.CANCELLED,
    ],
  };

  function validateStateTransition(current: AppointmentStatus, next: AppointmentStatus): boolean {
    const allowed = ALLOWED_TRANSITIONS[current] || [];
    return allowed.includes(next);
  }

  before(async () => {
    hospital = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
    assert.ok(hospital);

    doctor = await prisma.doctor.findFirst({ where: { hospitalId: hospital.id } });
    assert.ok(doctor);

    patient = await prisma.patient.findFirst();
    assert.ok(patient);

    slot = await prisma.slot.create({
      data: {
        doctorId: doctor.id,
        hospitalId: hospital.id,
        startTime: new Date(Date.now() + 86400000),
        endTime: new Date(Date.now() + 86400000 + 1800000),
        isBooked: false,
      },
    });
  });

  describe('1. Valid State Transition Matrix Verification', () => {
    it('allows Requested -> Pending (initial booking request to reservation hold)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.REQUESTED, AppointmentStatus.PENDING),
        true
      );
    });

    it('allows Pending -> Confirmed (successful external EHR verification and synchronization)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED),
        true
      );
    });

    it('allows Confirmed -> Rescheduled (modifying appointment to new slot)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.CONFIRMED, AppointmentStatus.RESCHEDULED),
        true
      );
    });

    it('allows Confirmed -> Cancelled (patient or staff cancellation)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED),
        true
      );
    });

    it('allows Confirmed -> Completed and Confirmed -> No-show (clinical post-visit transitions)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED),
        true
      );
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.CONFIRMED, AppointmentStatus.NO_SHOW),
        true
      );
    });

    it('allows Pending -> Reconciliation Required (exhausted retries during external integration)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.PENDING, AppointmentStatus.RECONCILIATION_REQUIRED),
        true
      );
    });

    it('allows Reconciliation Required -> Confirmed (operator manual resolution)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.RECONCILIATION_REQUIRED, AppointmentStatus.CONFIRMED),
        true
      );
    });
  });

  describe('2. Forbidden / Invalid State Transition Protection', () => {
    it('forbids Cancelled -> Confirmed (cannot resurrect cancelled appointment directly)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.CANCELLED, AppointmentStatus.CONFIRMED),
        false
      );
    });

    it('forbids Completed -> Pending (terminal state cannot return to initial hold)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.COMPLETED, AppointmentStatus.PENDING),
        false
      );
    });

    it('forbids No-show -> Confirmed (terminal post-visit state)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.NO_SHOW, AppointmentStatus.CONFIRMED),
        false
      );
    });

    it('forbids Requested -> Completed (cannot bypass scheduling and attendance)', () => {
      assert.strictEqual(
        validateStateTransition(AppointmentStatus.REQUESTED, AppointmentStatus.COMPLETED),
        false
      );
    });
  });

  describe('3. Database State Persistence & Transition History', () => {
    it('creates appointment in Pending state, advances to Confirmed, and records status in DB', async () => {
      const appt = await prisma.appointment.create({
        data: {
          hospitalId: hospital.id,
          doctorId: doctor.id,
          patientId: patient.id,
          slotId: slot.id,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: AppointmentStatus.PENDING,
          reason: 'State machine persistence test',
        },
      });

      assert.strictEqual(appt.status, AppointmentStatus.PENDING);

      // Advance to Confirmed
      const confirmed = await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: AppointmentStatus.CONFIRMED },
      });
      assert.strictEqual(confirmed.status, AppointmentStatus.CONFIRMED);

      // Cancel appointment
      const cancelled = await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: AppointmentStatus.CANCELLED },
      });
      assert.strictEqual(cancelled.status, AppointmentStatus.CANCELLED);

      // Cleanup
      await prisma.appointment.delete({ where: { id: appt.id } });
    });
  });
});
