import { prisma } from '@health/db';

async function main() {
  const dr = await prisma.doctor.findFirst({
    where: { name: { contains: 'Rao' } },
    include: {
      calendar: {
        include: { workingHours: true }
      }
    }
  });
  console.log('Calendar timezone:', dr?.calendar?.timezone);
  console.log('Working hours:');
  for (const wh of dr?.calendar?.workingHours || []) {
    console.log(`Day ${wh.dayOfWeek}: ${wh.startTime} - ${wh.endTime} (Active: ${wh.isActive})`);
  }
}
main().finally(() => prisma.$disconnect());
