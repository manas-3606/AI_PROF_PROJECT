import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const appt = await prisma.appointment.findFirst({
    where: { correlationId: { not: null } },
    orderBy: { createdAt: 'desc' },
    include: {
      stateHistories: true,
      workflowExecutions: {
        include: {
          workflow: true
        }
      },
      verifications: true,
      questionnaireResponses: true
    }
  });

  if (!appt) {
    console.log('No appointment with correlationId found');
    return;
  }

  const corrId = appt.correlationId!;
  console.log(`\n=== Distributed Trace for Appointment ${appt.id} (Correlation ID: ${corrId}) ===`);
  console.log(`Appointment Status: ${appt.status}, CreatedAt: ${appt.createdAt.toISOString()}`);
  
  // 1. Audit events with this correlationId
  const audits = await prisma.auditEvent.findMany({
    where: { correlationId: corrId },
    orderBy: { timestamp: 'asc' }
  });
  console.log(`\n1. Audit Events (${audits.length}):`);
  audits.forEach(a => {
    console.log(`   [${a.timestamp.toISOString()}] Action: ${a.action} | Entity: ${a.entityType}:${a.entityId || 'none'} | Actor: ${a.actorRole}`);
  });

  // 2. Capability executions
  const capabilities = await prisma.capabilityExecution.findMany({
    where: { correlationId: corrId },
    orderBy: { createdAt: 'asc' }
  });
  console.log(`\n2. Capability Executions (${capabilities.length}):`);
  capabilities.forEach(c => {
    console.log(`   [${c.createdAt.toISOString()}] Capability: ${c.capabilityName} | Status: ${c.status} | Duration: ${c.durationMs}ms`);
  });

  // 3. State Histories
  console.log(`\n3. Appointment State Transitions (${appt.stateHistories.length}):`);
  appt.stateHistories.forEach(h => {
    console.log(`   [${h.changedAt.toISOString()}] ${h.fromStatus} -> ${h.toStatus} (Reason: ${h.reason})`);
  });

  // 4. Verifications
  console.log(`\n4. Integration Verifications (${appt.verifications.length}):`);
  appt.verifications.forEach(v => {
    console.log(`   [${v.verifiedAt.toISOString()}] Match: ${v.match} | ExternalStatus: ${v.externalStatus} | Verified: ${v.isVerified}`);
  });

  // 5. Workflow Executions
  console.log(`\n5. Workflow Executions (${appt.workflowExecutions.length}):`);
  appt.workflowExecutions.forEach(w => {
    console.log(`   [${w.scheduledAt.toISOString()}] Workflow: ${w.workflow?.type} | Status: ${w.status} | Attempt: ${w.attemptCount}`);
  });

  // 6. Notifications
  const notifs = await prisma.notification.findMany({
    where: { recipientId: appt.patientId },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log(`\n6. Notifications Dispatched for Patient (${notifs.length}):`);
  notifs.forEach(n => {
    console.log(`   [${n.createdAt.toISOString()}] Channel: ${n.channel} | Type: ${n.recipientType} | Template: ${n.templateId} | Status: ${n.status}`);
  });
}

main().finally(() => prisma.$disconnect());
