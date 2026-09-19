import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const correlationIds = [
    'turn-1789846607503',
    'turn-1789846634988',
    'turn-1789846662692',
    'turn-1789846942755'
  ];

  for (const cid of correlationIds) {
    console.log(`\n=================== CORRELATION ID: ${cid} ===================`);
    const execs = await prisma.capabilityExecution.findMany({
      where: { correlationId: cid }
    });
    for (const ex of execs) {
      console.log(`Capability: ${ex.capabilityName}, Status: ${ex.status}`);
      console.log(`  Input: ${ex.inputJson}`);
      console.log(`  Output: ${ex.outputJson}`);
    }

    const audits = await prisma.auditEvent.findMany({
      where: { correlationId: cid }
    });
    for (const au of audits) {
      console.log(`Audit: ${au.action} on ${au.entityType}`);
      console.log(`  Details: ${au.detailsJson}`);
    }
  }

  // Also check AiConversations created around that time (2026-09-19T19:30:00Z to 2026-09-19T19:50:00Z)
  const convs = await prisma.aiConversation.findMany({
    where: {
      startTime: {
        gte: new Date('2026-09-19T19:30:00Z')
      }
    },
    include: {
      context: true
    }
  });

  console.log(`\nFound ${convs.length} AiConversations around that time:`);
  for (const c of convs) {
    console.log(`Conv ID: ${c.id}, Hospital: ${c.hospitalId}, Patient: ${c.patientId}, Start: ${c.startTime.toISOString()}`);
    if (c.context) {
      console.log(`  Context doctorId: ${c.context.selectedDoctorId}, slotId: ${c.context.selectedSlotId}`);
      console.log(`  Context JSON: ${c.context.contextJson}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
