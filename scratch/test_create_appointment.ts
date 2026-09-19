import { CapabilityRegistry } from '@health/capabilities';
import { prisma } from '@health/db';

async function testBooking() {
  const doc = await prisma.doctor.findFirst({
    where: { name: { contains: 'Rao' } },
    include: { hospital: true },
  });
  const patient = await prisma.patient.findFirst();
  const slot = await prisma.slot.findFirst({
    where: { doctorId: doc!.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });

  console.log('Doc:', doc?.name, doc?.id);
  console.log('Patient:', patient?.name, patient?.id);
  console.log('Slot:', slot?.id, slot?.startTime.toISOString());

  try {
    const res = await CapabilityRegistry.execute(
      'create_appointment',
      {
        patientId: patient!.id,
        doctorId: doc!.id,
        hospitalId: doc!.hospitalId,
        slotId: slot!.id,
        reason: 'Direct capability test',
        idempotencyKey: 'test-key-' + Date.now(),
      },
      {
        correlationId: 'test-' + Date.now(),
        conversationId: 'test-conv-' + Date.now(),
        hospitalId: doc!.hospitalId,
      }
    );
    console.log('SUCCESS:', res);
  } catch (err: any) {
    console.error('FAILED WITH ERROR:', err.message, err.stack);
  }
}

testBooking().then(() => prisma.$disconnect()).catch(err => {
  console.error(err);
  prisma.$disconnect();
});
