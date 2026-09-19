import { prisma } from '@health/db';

async function main() {
  console.log('=== INVESTIGATING DOCTOR MISMATCH (Dr. Rao vs Dr. Rostova) ===\n');

  // 1. Check doctors in database
  const doctors = await prisma.doctor.findMany({
    include: { hospital: true }
  });
  console.log(`Found ${doctors.length} doctors in DB:`);
  for (const d of doctors) {
    console.log(`- Doctor ID: ${d.id} | Name: "${d.name}" | Specialty: "${d.specialty}" | Hospital: "${d.hospital.name}" (${d.hospitalId})`);
  }

  // 2. Search AiTurnLog / AiConversation for any logs with Rao or Rostova or Monday
  console.log('\n--- Searching Recent AiTurnLog records ---');
  const logs = await prisma.aiTurnLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  console.log(`Total recent AiTurnLog entries: ${logs.length}`);
  for (const l of logs) {
    const utt = l.userUtterance || '';
    const resp = l.agentResponse || '';
    if (
      utt.toLowerCase().includes('rao') ||
      utt.toLowerCase().includes('rostova') ||
      utt.toLowerCase().includes('monday') ||
      resp.toLowerCase().includes('rao') ||
      resp.toLowerCase().includes('rostova')
    ) {
      console.log('\n--- Matching Turn Log ---');
      console.log('ID:', l.id);
      console.log('CreatedAt:', l.createdAt);
      console.log('ConversationID:', l.conversationId);
      console.log('CorrelationID:', l.correlationId);
      console.log('UserUtterance:', l.userUtterance);
      console.log('AgentResponse:', l.agentResponse);
      console.log('IntentDetected:', l.intentDetected);
      console.log('CapabilityCalled:', l.capabilityCalled);
      console.log('LatencyMs:', l.latencyMs);
    }
  }

  // 3. Search OperationalEvents / AuditEvents
  console.log('\n--- Searching Recent OperationalEvents ---');
  const opEvents = await prisma.operationalEvent.findMany({
    where: {
      OR: [
        { message: { contains: 'Rao' } },
        { message: { contains: 'Rostova' } },
        { message: { contains: 'appointment' } }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  for (const op of opEvents) {
    console.log(`[${op.createdAt.toISOString()}] [${op.eventType}] ${op.message} (Correlation: ${op.correlationId})`);
  }

  // 4. Search AiContext table
  console.log('\n--- Inspecting Active AiContext records ---');
  const contexts = await prisma.aiContext.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 10
  });
  for (const c of contexts) {
    console.log(`Conv: ${c.conversationId} | Updated: ${c.updatedAt.toISOString()} | JSON: ${c.contextJson?.slice(0, 150)}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
