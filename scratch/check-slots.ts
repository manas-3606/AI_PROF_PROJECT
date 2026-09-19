import { prisma } from '@health/db';

async function main() {
  const dr = await prisma.doctor.findFirst({ where: { name: { contains: 'Rao' } } });
  console.log('Dr Rao ID:', dr ? dr.id : 'none');
  if (!dr) return;
  const total = await prisma.slot.count({ where: { doctorId: dr.id } });
  const unbooked = await prisma.slot.count({ where: { doctorId: dr.id, isBooked: false } });
  console.log('Total slots:', total, 'Unbooked:', unbooked);
  const nextSlots = await prisma.slot.findMany({
    where: { doctorId: dr.id, isBooked: false, startTime: { gte: new Date() } },
    take: 10
  });
  console.log('Next unbooked slots count:', nextSlots.length);
  for (const s of nextSlots) {
    console.log(' - Slot:', s.startTime.toISOString(), 'to', s.endTime.toISOString(), 'Booked:', s.isBooked, 'Blocked:', s.isBlocked);
  }

  // Also check working hours for Dr Rao
  const cal = await prisma.calendar.findUnique({
    where: { doctorId: dr.id },
    include: { workingHours: true }
  });
  console.log('Working hours count:', cal?.workingHours.length);
}
main().finally(() => prisma.$disconnect());
