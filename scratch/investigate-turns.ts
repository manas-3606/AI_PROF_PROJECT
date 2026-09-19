import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('=== INVESTIGATING LIVE DATABASE LOGS ===');
  
  // 1. Check CapabilityExecution
  const executions = await prisma.capabilityExecution.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  console.log(`\nFound ${executions.length} CapabilityExecutions:`);
  for (const ex of executions) {
    console.log(`[${ex.createdAt.toISOString()}] ${ex.capabilityName} (corr: ${ex.correlationId}, conv: ${ex.conversationId}) - status: ${ex.status}`);
    console.log(`  Input: ${ex.inputJson}`);
    console.log(`  Output: ${ex.outputJson?.slice(0, 200)}`);
  }

  // 2. Check AiContext
  const contexts = await prisma.aiContext.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 10
  });
  console.log(`\nFound ${contexts.length} AiContexts:`);
  for (const ctx of contexts) {
    console.log(`[${ctx.updatedAt.toISOString()}] convId: ${ctx.conversationId}, doctorId: ${ctx.selectedDoctorId}, hospitalId: ${ctx.selectedHospitalId}, slotId: ${ctx.selectedSlotId}`);
    console.log(`  contextJson: ${ctx.contextJson}`);
  }

  // 3. Check OperationalEvent
  const opEvents = await prisma.operationalEvent.findMany({
    orderBy: { timestamp: 'desc' },
    take: 15
  });
  console.log(`\nFound ${opEvents.length} OperationalEvents:`);
  for (const ev of opEvents) {
    console.log(`[${ev.timestamp.toISOString()}] ${ev.eventType} (${ev.severity}) - ${ev.message} (corr: ${ev.correlationId})`);
    if (ev.detailsJson) console.log(`  Details: ${ev.detailsJson.slice(0, 200)}`);
  }

  // 4. Check AuditEvent
  const auditEvents = await prisma.auditEvent.findMany({
    orderBy: { timestamp: 'desc' },
    take: 15
  });
  console.log(`\nFound ${auditEvents.length} AuditEvents:`);
  for (const au of auditEvents) {
    console.log(`[${au.timestamp.toISOString()}] ${au.action} on ${au.entityType} (corr: ${au.correlationId})`);
    if (au.detailsJson) console.log(`  Details: ${au.detailsJson.slice(0, 200)}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
