import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';
import { prisma } from '../packages/db/src/index.js';

async function test() {
  const doctor = await prisma.doctor.findFirst({ where: { name: { contains: 'Rao' } }, include: { hospital: true } });
  const patient = await prisma.patient.findFirst({ where: { name: { contains: 'Jane' } } });
  const agent = new PatientAccessAgent({ conversationId: 'dbg-' + Date.now(), patientId: patient!.id, hospitalId: doctor!.hospitalId });
  const t1 = await agent.processTurn('What openings does Dr. Arvind Rao have this week?');
  console.log('T1 text:', t1.responseText);
  console.log('T1 intent:', t1.intentDetected);
  console.log('T1 context intent:', t1.context.currentIntent);
  console.log('T1 context offered:', t1.context.lastOfferedSlotIds);
  console.log('T1 context ambiguousOptions:', t1.context.ambiguousOptions);
}
test();
