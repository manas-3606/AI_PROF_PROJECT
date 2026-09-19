import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== CHECK 20: Distributed correlationId Lifecycle Trace ===');
  // Find appointments with correlationId
  const appointments = await prisma.appointment.findMany({
    where: { correlationId: { not: null } },
    take: 5,
    orderBy: { createdAt: 'desc' }
  });

  console.log(`Found ${appointments.length} appointments with correlationId.`);
  if (appointments.length === 0) {
    console.log('No appointment with correlationId found directly. Searching AuditEvent...');
  }

  // Find audit events grouped by correlationId that have multiple actions
  const auditEvents = await prisma.auditEvent.findMany({
    where: { correlationId: { not: null } },
    take: 50,
    orderBy: { timestamp: 'desc' }
  });

  const correlationMap = new Map<string, any[]>();
  for (const ev of auditEvents) {
    if (!ev.correlationId) continue;
    if (!correlationMap.has(ev.correlationId)) correlationMap.set(ev.correlationId, []);
    correlationMap.get(ev.correlationId)!.push(ev);
  }

  console.log(`Found ${correlationMap.size} distinct correlationIds in recent AuditEvents.`);
  for (const [corrId, events] of correlationMap.entries()) {
    console.log(`\nTrace for Correlation ID: ${corrId} (${events.length} events)`);
    events.forEach(e => console.log(`  - [${e.timestamp.toISOString()}] [${e.action}] entity=${e.entityType}:${e.entityId} actor=${e.actorRole}`));
  }

  // Let's also check appointment state histories and audit events for a full booking flow
  const fullFlow = await prisma.auditEvent.findMany({
    orderBy: { timestamp: 'desc' },
    take: 20
  });
  console.log('\nSample actions in AuditEvent:');
  const distinctActions = [...new Set(fullFlow.map(f => f.action))];
  console.log(distinctActions);

  console.log('\n=== CHECK 21: PHI Redaction in Audit Logs ===');
  // Check if any audit event detailsJson contains raw text or redactions
  const eventsWithDetails = await prisma.auditEvent.findMany({
    where: { detailsJson: { not: null } },
    take: 50,
    orderBy: { timestamp: 'desc' }
  });

  let redactedCount = 0;
  for (const ev of eventsWithDetails) {
    if (ev.detailsJson && (ev.detailsJson.includes('[REDACTED]') || ev.detailsJson.includes('REDACTED'))) {
      redactedCount++;
      console.log(`Found redacted audit entry: action=${ev.action} details=${ev.detailsJson}`);
    }
  }
  console.log(`Total events with REDACTED tag: ${redactedCount}`);
}

main().finally(() => prisma.$disconnect());
