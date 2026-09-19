import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';
import { prisma } from '../packages/db/src/index.js';

async function test1() {
  const doctor = await prisma.doctor.findFirst({ where: { name: { contains: 'Rao' } }, include: { hospital: true } });
  const patient = await prisma.patient.findFirst({ where: { name: { contains: 'Jane' } } });
  const convId = 'p0-test1-' + Date.now();
  const agent = new PatientAccessAgent({ conversationId: convId, patientId: patient!.id, hospitalId: doctor!.hospitalId });

  const t1 = await agent.processTurn('I would like to schedule an appointment with Dr. Arvind Rao');
  console.log('T1 Agent:', t1.responseText);
  console.log('T1 Offered:', t1.context.ambiguousOptions);

  const t2 = await agent.processTurn('I will take the second option please');
  console.log('T2 Agent:', t2.responseText);
  const appt = await prisma.appointment.findUnique({ where: { id: t2.context.activeAppointmentId } });
  console.log('Booked start:', appt?.startTime.toISOString());
  console.log('Second slot expected:', t1.context.ambiguousOptions?.[1]?.startTime);
  const matched = appt?.startTime.getTime() === new Date(t1.context.ambiguousOptions?.[1]?.startTime).getTime();
  console.log('MATCHED SECOND OPTION:', matched);
}
test1();
