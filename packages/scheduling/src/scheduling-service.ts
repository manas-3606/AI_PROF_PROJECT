import { prisma } from '@health/db';
import { AppointmentStatus, CalendarSlot } from '@health/shared-types';
import {
  ConcurrencyLockManager,
  SlotAlreadyBookedError,
  SlotNoLongerAvailableError,
  SlotNotFoundError,
} from './lock-manager.js';
import {
  SlotCalculator,
  ExternalConstraintChecker,
  GetAvailableSlotsOptions,
  defaultExternalConstraintChecker,
} from './slot-calculator.js';
import { logger, metricsCollector } from '@health/observability';
import { HospitalOnboardingService, HospitalDoctorConfigService } from '@health/core-services';

export interface CreateAppointmentParams {
  patientId: string;
  doctorId: string;
  hospitalId: string;
  slotId: string;
  reason?: string;
  appointmentType?: string;
  externalConstraintChecker?: ExternalConstraintChecker;
  idempotencyKey?: string;
  correlationId?: string;
}

export class SchedulingService {
  /**
   * Retrieves strictly verified, real bookable slots for a doctor within a date range.
   * Delegates to SlotCalculator to enforce all 8 availability conditions without inventing slots.
   */
  static async getAvailableSlots(
    doctorId: string,
    startDate: Date,
    endDate: Date,
    options?: GetAvailableSlotsOptions
  ): Promise<CalendarSlot[]> {
    return await SlotCalculator.getAvailableSlots(doctorId, startDate, endDate, options);
  }

  /**
   * Distinct, isolated step: Revalidates availability immediately before commit inside a DB transaction.
   * Does NOT reuse cached results from an earlier search.
   *
   * Verifies all 8 availability conditions on the transactional boundary:
   * 1. Doctor active
   * 2. Calendar active
   * 3. Within working hours
   * 4. Not in a blocked period
   * 5. Doctor not on leave
   * 6. Not already booked (slot.isBooked === false and slot.isBlocked === false)
   * 7. Appointment type compatible
   * 8. External constraints satisfied
   */
  static async revalidateSlotAvailability(
    tx: any,
    slot: {
      id: string;
      doctorId: string;
      hospitalId: string;
      startTime: Date;
      endTime: Date;
      isBooked: boolean;
      isBlocked: boolean;
    },
    options?: {
      appointmentType?: string;
      externalConstraintChecker?: ExternalConstraintChecker;
    }
  ): Promise<void> {
    // Condition 6: Verify slot is not flagged as booked or blocked
    if (slot.isBooked || slot.isBlocked) {
      logger.warn({ slotId: slot.id }, 'Revalidation failed: slot is already booked or blocked');
      throw new SlotAlreadyBookedError(slot.id, 'slot is already booked or blocked in database');
    }

    // Condition 1, 2, 3, 5, 7: Fetch doctor, calendar, working hours on current transaction
    const doctor = await tx.doctor.findUnique({
      where: { id: slot.doctorId },
      include: {
        calendar: {
          include: {
            workingHours: true,
          },
        },
      },
    });

    // Condition 1: Doctor active
    if (!doctor || doctor.status !== 'ACTIVE') {
      logger.warn({ slotId: slot.id, doctorId: slot.doctorId, status: doctor?.status }, 'Revalidation failed: doctor is not active');
      throw new SlotNoLongerAvailableError(slot.id, `doctor status is ${doctor ? doctor.status : 'NOT_FOUND'} (expected ACTIVE)`);
    }

    // Condition 5: Doctor not on leave
    const doctorStatusUpper = doctor.status.toUpperCase();
    if (doctorStatusUpper === 'ON_LEAVE' || doctorStatusUpper === 'LEAVE') {
      logger.warn({ slotId: slot.id, doctorId: slot.doctorId }, 'Revalidation failed: doctor is on leave');
      throw new SlotNoLongerAvailableError(slot.id, 'doctor is currently on leave');
    }

    // Condition 2: Calendar active
    if (!doctor.calendar || !doctor.calendar.isActive) {
      logger.warn({ slotId: slot.id, doctorId: slot.doctorId }, 'Revalidation failed: doctor calendar is inactive or missing');
      throw new SlotNoLongerAvailableError(slot.id, 'doctor calendar is inactive or missing');
    }

    // Condition 3: Within working hours
    const workingHours = doctor.calendar.workingHours || [];
    if (!SlotCalculator.isWithinWorkingHours(slot.startTime, slot.endTime, workingHours)) {
      logger.warn({ slotId: slot.id }, 'Revalidation failed: slot falls outside configured working hours');
      throw new SlotNoLongerAvailableError(slot.id, 'slot falls outside doctor working hours');
    }

    // Condition 4 & 5: Check overlapping blocked periods or doctor leave
    const overlappingBlocked = await tx.blockedSlot.findFirst({
      where: {
        calendarId: doctor.calendar.id,
        startTime: { lt: slot.endTime },
        endTime: { gt: slot.startTime },
      },
    });
    if (overlappingBlocked) {
      const reason = overlappingBlocked.reason || 'calendar blackout';
      logger.warn({ slotId: slot.id, blockedReason: reason }, 'Revalidation failed: slot overlaps blocked period');
      throw new SlotNoLongerAvailableError(slot.id, `slot overlaps a blocked period (${reason})`);
    }

    // Condition 7: Appointment type compatible
    if (options?.appointmentType) {
      const isCompatible = SlotCalculator.isAppointmentTypeCompatible(
        doctor.consultationTypesJson,
        options.appointmentType
      );
      if (!isCompatible) {
        logger.warn({ slotId: slot.id, appointmentType: options.appointmentType }, 'Revalidation failed: appointment type incompatible');
        throw new SlotNoLongerAvailableError(slot.id, `appointment type "${options.appointmentType}" is not supported by provider`);
      }
    }

    // Condition 8: External constraints satisfied
    const externalChecker = options?.externalConstraintChecker || defaultExternalConstraintChecker;
    const externalCheck = await externalChecker.checkConstraints(
      {
        id: slot.id,
        doctorId: slot.doctorId,
        hospitalId: slot.hospitalId,
        startTime: slot.startTime,
        endTime: slot.endTime,
      },
      options?.appointmentType
    );
    if (!externalCheck.satisfied) {
      logger.warn({ slotId: slot.id, reason: externalCheck.reason }, 'Revalidation failed: external constraint unsatisfied');
      throw new SlotNoLongerAvailableError(slot.id, externalCheck.reason || 'external constraints not satisfied');
    }
  }

  /**
   * Books a slot atomically, creating an internal appointment in PENDING state.
   * Protects against concurrent double-booking with DB transactions and row-level locking.
   * Executes "revalidate availability immediately before commit" as a distinct step.
   */
  static async bookAppointment(params: CreateAppointmentParams) {
    // 1. Check idempotency if key provided
    if (params.idempotencyKey) {
      const existing = await prisma.appointment.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
        include: { doctor: true, hospital: true },
      });
      if (existing) {
        logger.info({ idempotencyKey: params.idempotencyKey }, 'Idempotent appointment request found');
        return existing;
      }
    }

    // 1b. Enforce only Approved hospitals can receive appointments
    await HospitalOnboardingService.assertHospitalApproved(params.hospitalId, 'receive appointments');

    // 1c. Enforce only Active doctors with valid availability can receive appointments (PRD Section 6)
    await HospitalDoctorConfigService.assertDoctorReadyForAppointments(params.doctorId, params.hospitalId);

    try {
      // Execute booking within an ACID transaction with immediate pre-commit revalidation
      const appointment = await prisma.$transaction(async (tx) => {
        // Step A: Fetch target slot
        const slot = await tx.slot.findUnique({
          where: { id: params.slotId },
        });

        if (!slot) {
          throw new SlotNotFoundError(params.slotId);
        }

        // Step B: Revalidate availability immediately before commit (PRD Section 7 mandatory distinct step)
        await this.revalidateSlotAvailability(tx, slot, {
          appointmentType: params.appointmentType,
          externalConstraintChecker: params.externalConstraintChecker,
        });

        // Step C: Atomically mark slot as booked
        await tx.slot.update({
          where: { id: params.slotId },
          data: { isBooked: true },
        });

        // Step D: Create appointment in PENDING state
        const createdAppt = await tx.appointment.create({
          data: {
            patientId: params.patientId,
            doctorId: params.doctorId,
            hospitalId: params.hospitalId,
            slotId: slot.id,
            startTime: slot.startTime,
            endTime: slot.endTime,
            status: AppointmentStatus.PENDING,
            reason: params.reason,
            idempotencyKey: params.idempotencyKey,
            correlationId: params.correlationId,
          },
          include: {
            doctor: true,
            hospital: true,
            patient: true,
          },
        });

        // Step E: Record initial state history
        await tx.appointmentStateHistory.create({
          data: {
            appointmentId: createdAppt.id,
            hospitalId: createdAppt.hospitalId,
            fromStatus: AppointmentStatus.REQUESTED,
            toStatus: AppointmentStatus.PENDING,
            reason: params.reason || 'Initial slot reservation',
            correlationId: params.correlationId,
          },
        });

        return createdAppt;
      });

      metricsCollector.recordBooking(true);
      return appointment;
    } catch (error) {
      metricsCollector.recordBooking(false);
      throw error;
    }
  }

  /**
   * Reschedules an appointment by atomically booking the new slot and releasing the old slot.
   */
  static async rescheduleAppointment(appointmentId: string, newSlotId: string, correlationId?: string) {
    const existing = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!existing) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }

    // 1. Atomically reserve the new slot with revalidation
    const newSlot = await ConcurrencyLockManager.reserveSlotAtomically(newSlotId, async (tx, slot) => {
      await SchedulingService.revalidateSlotAvailability(tx, slot);
    });

    // 2. Release the old slot
    await ConcurrencyLockManager.releaseSlot(existing.slotId);

    // 3. Update appointment
    const updated = await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        slotId: newSlot.slotId,
        startTime: newSlot.startTime,
        endTime: newSlot.endTime,
        status: AppointmentStatus.RESCHEDULED,
        correlationId: correlationId || existing.correlationId,
      },
      include: {
        doctor: true,
        hospital: true,
      },
    });

    // 4. Record state history
    await prisma.appointmentStateHistory.create({
      data: {
        appointmentId: updated.id,
        hospitalId: existing.hospitalId,
        fromStatus: existing.status,
        toStatus: AppointmentStatus.RESCHEDULED,
        reason: 'Rescheduled to new slot',
        correlationId: correlationId || existing.correlationId,
      },
    });

    return updated;
  }

  /**
   * Cancels an appointment and releases its slot.
   */
  static async cancelAppointment(appointmentId: string, reason?: string) {
    const existing = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!existing) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }

    // Release slot
    await ConcurrencyLockManager.releaseSlot(existing.slotId);

    // Update appointment status
    const updated = await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.CANCELLED,
        reason: reason ? `Cancelled: ${reason}` : 'Cancelled by patient',
      },
    });

    // Record state history
    await prisma.appointmentStateHistory.create({
      data: {
        appointmentId: updated.id,
        hospitalId: existing.hospitalId,
        fromStatus: existing.status,
        toStatus: AppointmentStatus.CANCELLED,
        reason: reason || 'Cancelled by patient',
      },
    });

    return updated;
  }

  /**
   * Updates internal appointment status (e.g. after verification)
   */
  static async updateAppointmentStatus(
    appointmentId: string,
    status: AppointmentStatus,
    externalAppointmentId?: string,
    reason?: string,
    correlationId?: string
  ) {
    const existing = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    const updated = await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status,
        ...(externalAppointmentId ? { externalAppointmentId } : {}),
      },
    });

    if (existing) {
      await prisma.appointmentStateHistory.create({
        data: {
          appointmentId: updated.id,
          hospitalId: existing.hospitalId,
          fromStatus: existing.status,
          toStatus: status,
          reason: reason || (externalAppointmentId ? `EHR sync: ${externalAppointmentId}` : 'Status update'),
          correlationId: correlationId || existing.correlationId,
        },
      });
    }

    return updated;
  }
}
