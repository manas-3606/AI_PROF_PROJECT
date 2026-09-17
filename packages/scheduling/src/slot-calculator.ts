import { prisma } from '@health/db';
import { CalendarSlot } from '@health/shared-types';

export interface ExternalConstraintCheckResult {
  satisfied: boolean;
  reason?: string;
}

export interface ExternalConstraintChecker {
  checkConstraints(
    slot: { id?: string; doctorId: string; hospitalId: string; startTime: Date; endTime: Date },
    appointmentType?: string
  ): Promise<ExternalConstraintCheckResult>;
}

export class DefaultExternalConstraintChecker implements ExternalConstraintChecker {
  async checkConstraints(): Promise<ExternalConstraintCheckResult> {
    // Stub for Phase 3 external EHR / Payer constraint checks
    return { satisfied: true };
  }
}

export const defaultExternalConstraintChecker = new DefaultExternalConstraintChecker();

export interface GetAvailableSlotsOptions {
  appointmentType?: string;
  externalConstraintChecker?: ExternalConstraintChecker;
}

export class SlotCalculator {
  /**
   * Helper to evaluate whether a time interval falls strictly within configured working hours.
   */
  static isWithinWorkingHours(
    startTime: Date,
    endTime: Date,
    workingHours: Array<{ dayOfWeek: number; startTime: string; endTime: string }>
  ): boolean {
    if (!workingHours || workingHours.length === 0) {
      return false;
    }

    const localDay = startTime.getDay();
    const utcDay = startTime.getUTCDay();

    const localStartStr = String(startTime.getHours()).padStart(2, '0') + ':' + String(startTime.getMinutes()).padStart(2, '0');
    const localEndStr = String(endTime.getHours()).padStart(2, '0') + ':' + String(endTime.getMinutes()).padStart(2, '0');

    const utcStartStr = String(startTime.getUTCHours()).padStart(2, '0') + ':' + String(startTime.getUTCMinutes()).padStart(2, '0');
    const utcEndStr = String(endTime.getUTCHours()).padStart(2, '0') + ':' + String(endTime.getUTCMinutes()).padStart(2, '0');

    return workingHours.some((wh) => {
      const matchLocal = wh.dayOfWeek === localDay && localStartStr >= wh.startTime && localEndStr <= wh.endTime;
      const matchUtc = wh.dayOfWeek === utcDay && utcStartStr >= wh.startTime && utcEndStr <= wh.endTime;
      return matchLocal || matchUtc;
    });
  }

  /**
   * Evaluates appointment type compatibility against a doctor's supported consultation types.
   */
  static isAppointmentTypeCompatible(
    consultationTypesJson: string | null | undefined,
    requestedType?: string
  ): boolean {
    if (!requestedType) {
      return true;
    }
    try {
      const types: string[] = JSON.parse(consultationTypesJson || '[]');
      const normalizedRequested = requestedType.trim().toLowerCase();
      return types.some((t) => {
        const norm = t.trim().toLowerCase();
        return norm === normalizedRequested || norm.includes(normalizedRequested) || normalizedRequested.includes(norm);
      });
    } catch {
      return false;
    }
  }

  /**
   * Retrieves strictly verified, real bookable slots for a doctor within a date range.
   * Never invents availability.
   *
   * A slot is ONLY returned as available if ALL 8 criteria are met:
   * 1. Doctor active
   * 2. Calendar active
   * 3. Within working hours
   * 4. Not in a blocked period
   * 5. Doctor not on leave
   * 6. Not already booked (no booked flag & no active appointment)
   * 7. Appointment type compatible
   * 8. External constraints satisfied (stubbed for now)
   */
  static async getAvailableSlots(
    doctorId: string,
    startDate: Date,
    endDate: Date,
    options?: GetAvailableSlotsOptions
  ): Promise<CalendarSlot[]> {
    // 1. Verify doctor exists and is active (Condition 1 & 5)
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: {
        calendar: {
          include: {
            workingHours: true,
          },
        },
      },
    });

    if (!doctor || doctor.status !== 'ACTIVE') {
      return []; // Doctor not found or inactive / suspended / on leave -> return empty, never invent
    }

    // Doctor status check for leave (Condition 5)
    const upperStatus = doctor.status.toUpperCase();
    if (upperStatus === 'ON_LEAVE' || upperStatus === 'LEAVE') {
      return [];
    }

    // 2. Verify calendar exists and is active (Condition 2)
    if (!doctor.calendar || !doctor.calendar.isActive) {
      return [];
    }

    // 3. Verify working hours exist (Condition 3). If doctor has no working hours configured, return empty (No invented slots).
    const workingHours = doctor.calendar.workingHours || [];
    if (workingHours.length === 0) {
      return [];
    }

    // 4. Verify appointment type compatibility (Condition 7)
    if (!this.isAppointmentTypeCompatible(doctor.consultationTypesJson, options?.appointmentType)) {
      return [];
    }

    // 5. Fetch candidate slots in range from DB
    const candidateSlots = await prisma.slot.findMany({
      where: {
        doctorId,
        isBooked: false,
        isBlocked: false,
        startTime: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: {
        startTime: 'asc',
      },
    });

    if (candidateSlots.length === 0) {
      return []; // No real slots in DB -> return empty, never fabricate
    }

    // 6. Fetch existing active appointments on candidate slots (Condition 6)
    const activeAppointments = await prisma.appointment.findMany({
      where: {
        slotId: { in: candidateSlots.map((s) => s.id) },
        status: { notIn: ['CANCELLED'] },
      },
      select: { slotId: true },
    });
    const bookedSlotIds = new Set(activeAppointments.map((a) => a.slotId));

    // 7. Fetch doctor blocked periods / leaves in range (Conditions 4 & 5)
    const blockedPeriods = await prisma.blockedSlot.findMany({
      where: {
        calendarId: doctor.calendar.id,
        startTime: { lte: endDate },
        endTime: { gte: startDate },
      },
    });

    // 8. Filter strictly against all remaining constraints
    const externalChecker = options?.externalConstraintChecker || defaultExternalConstraintChecker;
    const validSlots: typeof candidateSlots = [];

    for (const slot of candidateSlots) {
      // Condition 6: Not already booked
      if (slot.isBooked || bookedSlotIds.has(slot.id)) {
        continue;
      }

      // Condition 3: Within working hours
      if (!this.isWithinWorkingHours(slot.startTime, slot.endTime, workingHours)) {
        continue;
      }

      // Condition 4 & 5: Not in a blocked period and doctor not on leave
      const overlappingBlocked = blockedPeriods.find((blocked) => {
        return slot.startTime < blocked.endTime && slot.endTime > blocked.startTime;
      });
      if (overlappingBlocked) {
        continue; // Blocked or on leave
      }

      // Condition 8: External constraints satisfied
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
        continue;
      }

      validSlots.push(slot);
    }

    return validSlots.map((s) => ({
      id: s.id,
      doctorId: s.doctorId,
      hospitalId: s.hospitalId,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime.toISOString(),
      isBooked: s.isBooked,
      isBlocked: s.isBlocked,
    }));
  }
}
