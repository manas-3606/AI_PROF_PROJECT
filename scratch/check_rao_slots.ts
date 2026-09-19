import { prisma } from '@health/db';

async function check() {
  const doc = await prisma.doctor.findFirst({ where: { name: { contains: 'Rao' } } });
  if (!doc) {
    console.log('Doctor not found');
    return;
  }
  console.log('Doctor:', doc.name, doc.id);
  const slots = await prisma.slot.findMany({ where: { doctorId: doc.id }, orderBy: { startTime: 'asc' } });
  console.log('Total slots:', slots.length);
  for (const s of slots) {
    console.log(s.id, s.startTime.toISOString(), 'isBooked:', s.isBooked);
  }
  const appts = await prisma.appointment.findMany({ where: { doctorId: doc.id } });
  console.log('Total appointments:', appts.length);
  for (const a of appts) {
    console.log(a.id, a.startTime.toISOString(), a.status);
  }
}

check().then(() => prisma.$disconnect()).catch(err => {
  console.error(err);
  prisma.$disconnect();
});
