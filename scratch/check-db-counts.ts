import { prisma } from '@health/db';

async function main() {
  const appointments = await prisma.appointment.count();
  const capabilityExecutions = await prisma.capabilityExecution.count();
  const integrationOps = await prisma.integrationOperation.count();
  const workflows = await prisma.workflowExecution.count();
  const notifications = await prisma.notification.count();
  const auditEvents = await prisma.auditEvent.count();
  const slots = await prisma.slot.count({ where: { isBooked: true } });
  const questionnaires = await prisma.questionnaireResponse.count();

  console.log('--- DATABASE COUNTS ---');
  console.log({
    appointments,
    capabilityExecutions,
    integrationOps,
    workflows,
    notifications,
    auditEvents,
    bookedSlots: slots,
    questionnaires
  });

  const recentAppts = await prisma.appointment.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { doctor: true, hospital: true, patient: true }
  });
  console.log('Recent appointments:', JSON.stringify(recentAppts, null, 2));
}

main().catch(console.error);
