import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import {
  SlotCalculator,
  SchedulingService,
  ExternalConstraintChecker,
  ExternalConstraintCheckResult,
} from '@health/scheduling';

describe('Unit Test: Slot Availability & No Invented Slots (PRD Section 7)', () => {
  let testDoctor: any;
  let testHospital: any;

  before(async () => {
    testDoctor = await prisma.doctor.findFirst({
      where: { name: 'Dr. Arvind Rao' },
      include: {
        calendar: {
          include: {
            workingHours: true,
          },
        },
      },
    });
    assert.ok(testDoctor, 'Dr. Arvind Rao should exist in seeded database');
    assert.ok(testDoctor.calendar, 'Doctor calendar must exist');
    testHospital = await prisma.hospital.findUnique({
      where: { id: testDoctor.hospitalId },
    });
  });

  describe('1. No Invented Slots Guarantee (PRD Section 7)', () => {
    it('returns empty array [] when doctor does not exist (never invents slots)', async () => {
      const slots = await SlotCalculator.getAvailableSlots(
        'non-existent-doctor-uuid',
        new Date(),
        new Date(Date.now() + 7 * 86400000)
      );
      assert.strictEqual(slots.length, 0, 'Must return empty array for non-existent doctor');
    });

    it('returns empty array [] when doctor has no calendar configured', async () => {
      // Create temporary doctor without calendar
      const user = await prisma.user.create({
        data: {
          email: `doc.nocalendar.${Date.now()}@example.com`,
          passwordHash: 'hash',
          name: 'Dr. No Calendar',
          role: 'DOCTOR',
        },
      });
      const doctorNoCal = await prisma.doctor.create({
        data: {
          userId: user.id,
          hospitalId: testHospital.id,
          name: 'Dr. No Calendar',
          specialty: 'General',
          department: 'General Medicine',
          qualifications: 'MD',
          status: 'ACTIVE',
        },
      });

      try {
        const slots = await SlotCalculator.getAvailableSlots(
          doctorNoCal.id,
          new Date(),
          new Date(Date.now() + 7 * 86400000)
        );
        assert.strictEqual(slots.length, 0, 'Doctor without calendar must have 0 available slots (no fabrication)');
      } finally {
        await prisma.doctor.delete({ where: { id: doctorNoCal.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    });

    it('returns empty array [] when doctor has a calendar but NO working hours configured', async () => {
      const user = await prisma.user.create({
        data: {
          email: `doc.noworkhours.${Date.now()}@example.com`,
          passwordHash: 'hash',
          name: 'Dr. No Working Hours',
          role: 'DOCTOR',
        },
      });
      const doctorNoWh = await prisma.doctor.create({
        data: {
          userId: user.id,
          hospitalId: testHospital.id,
          name: 'Dr. No Working Hours',
          specialty: 'General',
          department: 'General Medicine',
          qualifications: 'MD',
          status: 'ACTIVE',
        },
      });
      const cal = await prisma.calendar.create({
        data: {
          doctorId: doctorNoWh.id,
          hospitalId: testHospital.id,
          name: 'Empty Schedule',
          isActive: true,
        },
      });

      try {
        const slots = await SlotCalculator.getAvailableSlots(
          doctorNoWh.id,
          new Date(),
          new Date(Date.now() + 7 * 86400000)
        );
        assert.strictEqual(slots.length, 0, 'Doctor without working hours must have 0 slots (no fabrication)');
      } finally {
        await prisma.calendar.delete({ where: { id: cal.id } });
        await prisma.doctor.delete({ where: { id: doctorNoWh.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    });

    it('returns empty array [] when there are no real slot records in the database for the timeframe', async () => {
      // Query far future date where no slots are generated
      const farFutureStart = new Date('2035-01-01T09:00:00Z');
      const farFutureEnd = new Date('2035-01-02T17:00:00Z');

      const slots = await SlotCalculator.getAvailableSlots(testDoctor.id, farFutureStart, farFutureEnd);
      assert.strictEqual(slots.length, 0, 'Must return empty array if no slot rows exist in DB (no invented slots)');
    });
  });

  describe('2. All 8 Availability Conditions Verification (PRD Section 7)', () => {
    it('Condition 1 & 2: excludes all slots if doctor is INACTIVE or calendar is disabled', async () => {
      // Update doctor to INACTIVE temporarily
      await prisma.doctor.update({
        where: { id: testDoctor.id },
        data: { status: 'INACTIVE' },
      });

      const now = new Date();
      const in7Days = new Date(Date.now() + 7 * 86400000);

      try {
        const slotsInactiveDoc = await SlotCalculator.getAvailableSlots(testDoctor.id, now, in7Days);
        assert.strictEqual(slotsInactiveDoc.length, 0, 'Inactive doctor must return 0 available slots');
      } finally {
        await prisma.doctor.update({
          where: { id: testDoctor.id },
          data: { status: 'ACTIVE' },
        });
      }

      // Disable calendar temporarily
      await prisma.calendar.update({
        where: { id: testDoctor.calendar.id },
        data: { isActive: false },
      });

      try {
        const slotsInactiveCal = await SlotCalculator.getAvailableSlots(testDoctor.id, now, in7Days);
        assert.strictEqual(slotsInactiveCal.length, 0, 'Doctor with inactive calendar must return 0 available slots');
      } finally {
        await prisma.calendar.update({
          where: { id: testDoctor.calendar.id },
          data: { isActive: true },
        });
      }
    });

    it('Condition 3: excludes slots that fall outside doctor working hours', async () => {
      // Create an early morning slot at 04:00 AM (working hours are 09:00 - 17:00)
      const slotStartTime = new Date();
      slotStartTime.setDate(slotStartTime.getDate() + 10);
      const day = slotStartTime.getDay();
      const diff = (1 - day + 7) % 7;
      slotStartTime.setDate(slotStartTime.getDate() + (diff === 0 ? 7 : diff));
      slotStartTime.setHours(4, 0, 0, 0);

      const slotEndTime = new Date(slotStartTime);
      slotEndTime.setMinutes(slotStartTime.getMinutes() + 30);

      const outsideSlot = await prisma.slot.create({
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
        const availableSlots = await SlotCalculator.getAvailableSlots(
          testDoctor.id,
          new Date(slotStartTime.getTime() - 3600000),
          new Date(slotEndTime.getTime() + 3600000)
        );

        const found = availableSlots.some((s) => s.id === outsideSlot.id);
        assert.strictEqual(found, false, 'Slot at 04:00 AM outside working hours must NOT be returned as available');
      } finally {
        await prisma.slot.delete({ where: { id: outsideSlot.id } });
      }
    });

    it('Condition 4 & 5: excludes slots in a blocked period or when doctor is on leave', async () => {
      // Create a test slot in working hours
      const slotStartTime = new Date();
      slotStartTime.setDate(slotStartTime.getDate() + 12);
      const day = slotStartTime.getDay();
      const diff = (1 - day + 7) % 7;
      slotStartTime.setDate(slotStartTime.getDate() + (diff === 0 ? 7 : diff));
      slotStartTime.setHours(14, 0, 0, 0);

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

      // Add a blocked period representing Doctor Vacation / Leave
      const leaveBlock = await prisma.blockedSlot.create({
        data: {
          calendarId: testDoctor.calendar.id,
          hospitalId: testHospital.id,
          startTime: new Date(slotStartTime.getTime() - 1800000),
          endTime: new Date(slotEndTime.getTime() + 1800000),
          reason: 'Annual Vacation Leave',
        },
      });

      try {
        const availableSlots = await SlotCalculator.getAvailableSlots(
          testDoctor.id,
          new Date(slotStartTime.getTime() - 3600000),
          new Date(slotEndTime.getTime() + 3600000)
        );

        const found = availableSlots.some((s) => s.id === testSlot.id);
        assert.strictEqual(found, false, 'Slot intersecting doctor leave/blocked period must NOT be returned as available');
      } finally {
        await prisma.blockedSlot.delete({ where: { id: leaveBlock.id } });
        await prisma.slot.delete({ where: { id: testSlot.id } });
      }
    });

    it('Condition 6: excludes slots that are already booked', async () => {
      const slotStartTime = new Date();
      slotStartTime.setDate(slotStartTime.getDate() + 13);
      const day = slotStartTime.getDay();
      const diff = (1 - day + 7) % 7;
      slotStartTime.setDate(slotStartTime.getDate() + (diff === 0 ? 7 : diff));
      slotStartTime.setHours(15, 0, 0, 0);

      const slotEndTime = new Date(slotStartTime);
      slotEndTime.setMinutes(slotStartTime.getMinutes() + 30);

      const bookedSlot = await prisma.slot.create({
        data: {
          doctorId: testDoctor.id,
          hospitalId: testHospital.id,
          startTime: slotStartTime,
          endTime: slotEndTime,
          isBooked: true, // Marked booked
          isBlocked: false,
        },
      });

      try {
        const availableSlots = await SlotCalculator.getAvailableSlots(
          testDoctor.id,
          new Date(slotStartTime.getTime() - 3600000),
          new Date(slotEndTime.getTime() + 3600000)
        );

        const found = availableSlots.some((s) => s.id === bookedSlot.id);
        assert.strictEqual(found, false, 'Booked slot must not be returned in availability results');
      } finally {
        await prisma.slot.delete({ where: { id: bookedSlot.id } });
      }
    });

    it('Condition 7: filters by appointment type compatibility', async () => {
      // Ensure doctor has an unbooked slot aligned with working hours
      const wh = testDoctor.calendar?.workingHours?.[0] || { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };
      const [startH, startM] = wh.startTime.split(':').map(Number);
      const d = new Date();
      d.setDate(d.getDate() + ((wh.dayOfWeek - d.getDay() + 7) % 7 || 7));
      d.setHours(startH, startM, 0, 0);

      const workingHours = testDoctor.calendar?.workingHours || [];
      let slotStart = new Date(d);
      while (
        (await prisma.slot.findFirst({ where: { doctorId: testDoctor.id, startTime: slotStart } })) ||
        !SlotCalculator.isWithinWorkingHours(slotStart, new Date(slotStart.getTime() + 30 * 60000), workingHours)
      ) {
        slotStart = new Date(slotStart.getTime() + 30 * 60000);
        if (slotStart.getHours() >= 17) {
          slotStart.setDate(slotStart.getDate() + 1);
          slotStart.setHours(startH, startM, 0, 0);
        }
      }
      const slotEnd = new Date(slotStart.getTime() + 30 * 60000);

      const tempSlot = await prisma.slot.create({
        data: {
          doctorId: testDoctor.id,
          hospitalId: testDoctor.hospitalId,
          startTime: slotStart,
          endTime: slotEnd,
          isBooked: false,
          isBlocked: false,
        },
      });

      try {
        const queryStart = new Date(slotStart.getTime() - 86400000);
        const queryEnd = new Date(slotEnd.getTime() + 86400000);

        // Compatible request
        const telehealthSlots = await SlotCalculator.getAvailableSlots(testDoctor.id, queryStart, queryEnd, {
          appointmentType: 'Telehealth',
        });
        assert.ok(telehealthSlots.length > 0, 'Telehealth should match Dr. Rao consultation types');

        // Incompatible request
        const incompatibleSlots = await SlotCalculator.getAvailableSlots(testDoctor.id, queryStart, queryEnd, {
          appointmentType: 'Emergency-Neurosurgery',
        });
        assert.strictEqual(
          incompatibleSlots.length,
          0,
          'Incompatible appointment type must return 0 slots'
        );
      } finally {
        await prisma.slot.delete({ where: { id: tempSlot.id } });
      }
    });

    it('Condition 8: external constraints satisfied where applicable (stubbed)', async () => {
      const wh = testDoctor.calendar?.workingHours?.[0] || { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };
      const [startH, startM] = wh.startTime.split(':').map(Number);
      const d = new Date();
      d.setDate(d.getDate() + ((wh.dayOfWeek - d.getDay() + 7) % 7 || 7));
      d.setHours(startH, startM, 0, 0);

      const workingHours = testDoctor.calendar?.workingHours || [];
      let slotStart = new Date(d);
      while (
        (await prisma.slot.findFirst({ where: { doctorId: testDoctor.id, startTime: slotStart } })) ||
        !SlotCalculator.isWithinWorkingHours(slotStart, new Date(slotStart.getTime() + 30 * 60000), workingHours)
      ) {
        slotStart = new Date(slotStart.getTime() + 30 * 60000);
        if (slotStart.getHours() >= 17) {
          slotStart.setDate(slotStart.getDate() + 1);
          slotStart.setHours(startH, startM, 0, 0);
        }
      }
      const slotEnd = new Date(slotStart.getTime() + 30 * 60000);

      const tempSlot = await prisma.slot.create({
        data: {
          doctorId: testDoctor.id,
          hospitalId: testDoctor.hospitalId,
          startTime: slotStart,
          endTime: slotEnd,
          isBooked: false,
          isBlocked: false,
        },
      });

      try {
        const queryStart = new Date(slotStart.getTime() - 86400000);
        const queryEnd = new Date(slotEnd.getTime() + 86400000);

        // Default stub check -> satisfied
        const defaultSlots = await SlotCalculator.getAvailableSlots(testDoctor.id, queryStart, queryEnd);
        assert.ok(defaultSlots.length > 0, 'Default stub satisfies external constraints');

        // Custom mock external checker that fails constraint (e.g. EHR provider external blackout)
        const failingExternalChecker: ExternalConstraintChecker = {
          async checkConstraints(): Promise<ExternalConstraintCheckResult> {
            return { satisfied: false, reason: 'EHR external sync unavailable' };
          },
        };

        const constrainedSlots = await SlotCalculator.getAvailableSlots(testDoctor.id, queryStart, queryEnd, {
          externalConstraintChecker: failingExternalChecker,
        });
        assert.strictEqual(
          constrainedSlots.length,
          0,
          'Slots failing external constraint check must NOT be returned'
        );
      } finally {
        await prisma.slot.delete({ where: { id: tempSlot.id } });
      }
    });

    it('SchedulingService.getAvailableSlots delegates seamlessly with identical verification', async () => {
      const now = new Date();
      const in7Days = new Date(Date.now() + 7 * 86400000);

      const serviceSlots = await SchedulingService.getAvailableSlots(testDoctor.id, now, in7Days);
      const calculatorSlots = await SlotCalculator.getAvailableSlots(testDoctor.id, now, in7Days);

      assert.strictEqual(serviceSlots.length, calculatorSlots.length);
      assert.deepStrictEqual(
        serviceSlots.map((s) => s.id),
        calculatorSlots.map((s) => s.id)
      );
    });
  });
});
