import { prisma } from '@health/db';
import { SlotCalculator } from '@health/scheduling';

async function main() {
  const dr = await prisma.doctor.findFirst({
    where: { name: { contains: 'Rao' } },
    include: { calendar: { include: { workingHours: true } } }
  });
  console.log('Doctor:', dr?.name);
  console.log('Calendar:', dr?.calendar?.isActive, 'Working hours:', dr?.calendar?.workingHours);

  const now = new Date();
  const end = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  console.log('Searching range:', now.toISOString(), 'to', end.toISOString());

  const thisWeekSlots = await prisma.slot.findMany({
    where: { doctorId: dr!.id, startTime: { gte: now, lte: new Date(Date.now() + 7 * 86400000) } },
    orderBy: { startTime: 'asc' }
  });
  console.log('Total slots for Dr Rao in next 7 days:', thisWeekSlots.length);
  for (const s of thisWeekSlots) {
    console.log(' - Slot:', s.startTime.toISOString(), 'isBooked:', s.isBooked, 'isBlocked:', s.isBlocked);
  }

  // Let's inspect candidate slots from DB directly
  const candidates = await prisma.slot.findMany({
    where: {
      doctorId: dr!.id,
      isBooked: false,
      isBlocked: false,
      startTime: { gte: now, lte: end }
    }
  });
  console.log('Candidate slots in DB:', candidates.length);
  for (const c of candidates.slice(0, 5)) {
    const isWithin = SlotCalculator.isWithinWorkingHours(c.startTime, c.endTime, dr!.calendar!.workingHours);
    console.log('Slot:', c.startTime.toISOString(), 'isWithinWorkingHours:', isWithin, 'startTime:', c.startTime.getHours() + ':' + c.startTime.getMinutes());
  }

  process.exit(0);
}

main().catch(console.error);
