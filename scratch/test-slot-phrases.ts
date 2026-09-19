import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';
import { prisma } from '../packages/db/src/index.js';

async function testPhrases() {
  const doctor = await prisma.doctor.findFirst({ where: { name: { contains: 'Rao' } }, include: { hospital: true } });
  const patient = await prisma.patient.findFirst({ where: { name: { contains: 'Jane' } } });

  // Test "not the late one"
  console.log('--- Testing: "not the late one" ---');
  const convA = 'test-late-' + Date.now();
  const agentA = new PatientAccessAgent({ conversationId: convA, patientId: patient!.id, hospitalId: doctor!.hospitalId });
  const tA1 = await agentA.processTurn('What openings does Dr. Arvind Rao have this week?');
  console.log('Offered:', tA1.context.ambiguousOptions?.map((s: any) => s.startTime));
  const tA2 = await agentA.processTurn('not the late one');
  const apptA = await prisma.appointment.findUnique({ where: { id: tA2.context.activeAppointmentId } });
  console.log('User said: "not the late one" -> Booked start:', apptA?.startTime.toISOString());
  console.log('Early slot was:', tA1.context.ambiguousOptions?.[0]?.startTime);
  console.log('Late slot was:', tA1.context.ambiguousOptions?.[tA1.context.ambiguousOptions.length - 1]?.startTime);

  // Test "the 11:00 one"
  console.log('\n--- Testing: "the 11:00 one" ---');
  const convB = 'test-time-' + Date.now();
  const agentB = new PatientAccessAgent({ conversationId: convB, patientId: patient!.id, hospitalId: doctor!.hospitalId });
  const tB1 = await agentB.processTurn('What openings does Dr. Arvind Rao have this week?');
  console.log('Offered:', tB1.context.ambiguousOptions?.map((s: any) => s.startTime));
  const tB2 = await agentB.processTurn('the 11:00 one please');
  const apptB = await prisma.appointment.findUnique({ where: { id: tB2.context.activeAppointmentId } });
  console.log('User said: "the 11:00 one please" -> Booked start:', apptB?.startTime.toISOString());
}
testPhrases();
