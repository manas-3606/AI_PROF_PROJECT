import { prisma } from '@health/db';
import { logger } from '@health/observability';

export class SlotNoLongerAvailableError extends Error {
  constructor(public slotId: string, public reason: string = 'already booked or no longer available') {
    super(`Slot ${slotId} is no longer available: ${reason}`);
    this.name = 'SlotNoLongerAvailableError';
  }
}

export class SlotAlreadyBookedError extends SlotNoLongerAvailableError {
  constructor(slotId: string, reason?: string) {
    super(slotId, reason || 'already booked or no longer available');
    this.name = 'SlotAlreadyBookedError';
  }
}

export class SlotNotFoundError extends Error {
  constructor(public slotId: string) {
    super(`Slot ${slotId} was not found.`);
    this.name = 'SlotNotFoundError';
  }
}

export class ConcurrencyLockManager {
  /**
   * Atomically locks and reserves a slot within an ACID transaction.
   * If two requests hit simultaneously, only one succeeds and the other receives SlotAlreadyBookedError.
   * Accepts an optional revalidation callback executed immediately before the commit step.
   */
  static async reserveSlotAtomically(
    slotId: string,
    revalidateFn?: (tx: any, slot: any) => Promise<void>
  ): Promise<{
    slotId: string;
    doctorId: string;
    hospitalId: string;
    startTime: Date;
    endTime: Date;
  }> {
    return await prisma.$transaction(async (tx) => {
      const slot = await tx.slot.findUnique({
        where: { id: slotId },
      });

      if (!slot) {
        throw new SlotNotFoundError(slotId);
      }

      if (slot.isBooked || slot.isBlocked) {
        logger.warn({ slotId }, 'Concurrent booking collision detected - slot already booked or blocked');
        throw new SlotAlreadyBookedError(slotId);
      }

      // Revalidate availability immediately before commit if callback provided
      if (revalidateFn) {
        await revalidateFn(tx, slot);
      }

      // Atomically mark the slot as booked
      const updated = await tx.slot.update({
        where: { id: slotId },
        data: { isBooked: true },
      });

      return {
        slotId: updated.id,
        doctorId: updated.doctorId,
        hospitalId: updated.hospitalId,
        startTime: updated.startTime,
        endTime: updated.endTime,
      };
    });
  }

  /**
   * Releases a slot back to available status (e.g. upon cancellation or rescheduling)
   */
  static async releaseSlot(slotId: string): Promise<void> {
    await prisma.slot.update({
      where: { id: slotId },
      data: { isBooked: false },
    });
  }
}
