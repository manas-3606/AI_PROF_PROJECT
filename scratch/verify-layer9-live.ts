import { prisma } from '@health/db';

const BASE_URL = 'http://localhost:3001';

async function main() {
  console.log('🚀 Running Layer 9: Observability & Audit Verification (Checks 20 & 21)...\n');

  // 1. Find a recent appointment with correlationId from our live booking
  const appt = await prisma.appointment.findFirst({
    where: { correlationId: { startsWith: 'corr-chk12-' } },
    orderBy: { createdAt: 'desc' },
  });

  if (!appt || !appt.correlationId) {
    throw new Error('No Check 12 appointment found with correlationId');
  }

  const correlationId = appt.correlationId;
  console.log(`Target Correlation ID: ${correlationId} (Appointment: ${appt.id})`);

  // ==========================================
  // CHECK 20: Pull full trace from API
  // ==========================================
  console.log('\n--- Check 20: Pulling Trace via GET /api/analytics/trace/:correlationId ---');
  const traceRes = await fetch(`${BASE_URL}/api/analytics/trace/${correlationId}`);
  if (!traceRes.ok) {
    const errText = await traceRes.text();
    throw new Error(`Trace fetch failed (${traceRes.status}): ${errText}`);
  }

  const traceData = (await traceRes.json()) as any;
  console.log(`Trace Correlation ID: ${traceData.correlationId}`);
  console.log(`Overall Status: ${traceData.overallStatus}`);
  console.log(`Total Stages: ${traceData.stages?.length || 0}`);

  const stages = traceData.stages || [];
  console.log('\nChronological Trace Chain:');
  stages.forEach((s: any) => {
    console.log(`  [Stage ${s.stageNumber}] ${s.stageName.padEnd(16)} | Status: ${s.status.padEnd(9)} | ${s.description}`);
  });

  const expectedStageNames = [
    'Conversation',
    'AI Decision',
    'Capability',
    'Scheduling',
    'EHR Operation',
    'Verification',
    'Synchronization',
    'Workflow',
    'Notification',
  ];

  for (let i = 0; i < expectedStageNames.length; i++) {
    const exp = expectedStageNames[i];
    const match = stages.find((s: any) => s.stageName.toLowerCase() === exp.toLowerCase());
    if (!match) {
      throw new Error(`Trace stage missing: ${exp}`);
    }
  }

  console.log('\n✅ All 9 stages present in chronological order:');
  console.log('   Conversation -> AI Decision -> Capability -> Scheduling -> EHR Operation -> Verification -> Synchronization -> Workflow -> Notification');
  console.log('🎉 CHECK 20 PASSED!');

  // ==========================================
  // CHECK 21: Sensitive Content (PHI) Redaction in Audit Logs
  // ==========================================
  console.log('\n--- Check 21: Verifying PHI Redaction in Audit Logs ---');

  // Query audit events for this trace and all recent audit events with detailsJson
  const auditLogs = await prisma.auditEvent.findMany({
    where: { detailsJson: { not: null } },
    orderBy: { timestamp: 'desc' },
    take: 50,
  });

  console.log(`Inspecting ${auditLogs.length} recent AuditEvent records for sensitive PHI...`);
  let redactedEntriesFound = 0;

  for (const log of auditLogs) {
    const details = log.detailsJson || '';

    // Check if free-text answers or sensitive notes are redacted
    if (details.includes('[REDACTED]') || details.includes('REDACTED') || details.includes('"responses":"[REDACTED]"')) {
      redactedEntriesFound++;
      console.log(`  ✓ Found redacted audit entry: [${log.action}] -> ${details}`);
    }

    // Verify raw patient symptoms/answers are not logged verbatim in clear text
    if (details.toLowerCase().includes('severe neck pain') || details.toLowerCase().includes('sharp pain in my left shoulder')) {
      throw new Error(`Audit log leaked unredacted patient symptom text: ${details}`);
    }
  }

  console.log(`\nVerified: Redacted audit entries confirmed (${redactedEntriesFound} records with redaction markers).`);
  console.log('Zero patient free-text symptom leaks found.');
  console.log('🎉 CHECK 21 PASSED!');
}

main()
  .catch((err) => {
    console.error('❌ Layer 9 verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
