import { prisma } from '@health/db';

async function verifyLayer1() {
  console.log('=== LAYER 1: Data & Schema Integrity Verification ===\n');

  // Check 1: Section 22 Entities
  console.log('--- Check 1: Section 22 Entity Verification ---');
  const section22Entities = [
    { entity: 'Platform', model: prisma.platform },
    { entity: 'Hospital', model: prisma.hospital },
    { entity: 'Hospital Admin/Staff', model: prisma.user, mapping: 'Consolidated into User with role: HOSPITAL_ADMIN / HOSPITAL_STAFF per ADR-012' },
    { entity: 'Department', model: prisma.department },
    { entity: 'Specialty', model: prisma.specialty },
    { entity: 'Doctor', model: prisma.doctor },
    { entity: 'Calendar', model: prisma.calendar },
    { entity: 'Availability', model: prisma.workingHour, mapping: 'Decomposed into WorkingHour + BlockedSlot + Slot per ADR-013' },
    { entity: 'Blocked Slot', model: prisma.blockedSlot },
    { entity: 'Patient', model: prisma.patient },
    { entity: 'User Context/Preferences', model: prisma.userPreference },
    { entity: 'Appointment', model: prisma.appointment },
    { entity: 'Questionnaire', model: prisma.questionnaire },
    { entity: 'Questionnaire Response', model: prisma.questionnaireResponse },
    { entity: 'AI Conversation', model: prisma.aiConversation },
    { entity: 'AI Context', model: prisma.aiContext },
    { entity: 'Capability', model: prisma.capability },
    { entity: 'Capability Execution', model: prisma.capabilityExecution },
    { entity: 'Healthcare-System Connection', model: prisma.healthcareSystemConnection },
    { entity: 'External Identifier Mapping', model: prisma.externalIdentifierMapping },
    { entity: 'Integration Operation', model: prisma.integrationOperation },
    { entity: 'Integration Verification', model: prisma.integrationVerification },
    { entity: 'Reconciliation Record', model: prisma.reconciliationRecord },
    { entity: 'Workflow', model: prisma.workflow },
    { entity: 'Workflow Execution', model: prisma.workflowExecution },
    { entity: 'Notification', model: prisma.notification },
    { entity: 'AI Evaluation', model: prisma.aiEvaluation },
    { entity: 'Audit Event', model: prisma.auditEvent },
    { entity: 'Operational Event', model: prisma.operationalEvent },
  ];

  let missingEntities = 0;
  for (const item of section22Entities) {
    try {
      const count = await (item.model as any).count();
      console.log(`✅ [${item.entity}] -> Table ${(item.model as any).name || 'OK'}: ${count} records ${item.mapping ? '(' + item.mapping + ')' : ''}`);
    } catch (err: any) {
      console.error(`❌ [${item.entity}] FAILED: ${err.message}`);
      missingEntities++;
    }
  }

  // Check 2: 6 State Categories in Distinct Tables
  console.log('\n--- Check 2: 6 State Categories in Distinct Tables (PRD Section 23) ---');
  const stateCategories = [
    { name: '1. Transactional State', tables: ['Appointment', 'AppointmentStateHistory', 'Slot'], delegates: [prisma.appointment, prisma.appointmentStateHistory, prisma.slot] },
    { name: '2. Conversational State', tables: ['AiConversation'], delegates: [prisma.aiConversation] },
    { name: '3. User Context', tables: ['UserPreference', 'AiContext'], delegates: [prisma.userPreference, prisma.aiContext] },
    { name: '4. Workflow State', tables: ['Workflow', 'WorkflowExecution'], delegates: [prisma.workflow, prisma.workflowExecution] },
    { name: '5. Integration State', tables: ['IntegrationOperation', 'IntegrationVerification', 'ExternalIdentifierMapping'], delegates: [prisma.integrationOperation, prisma.integrationVerification, prisma.externalIdentifierMapping] },
    { name: '6. Operational State', tables: ['ReconciliationRecord', 'OperationalEvent', 'AuditEvent'], delegates: [prisma.reconciliationRecord, prisma.operationalEvent, prisma.auditEvent] },
  ];

  for (const cat of stateCategories) {
    console.log(`\n📌 ${cat.name}:`);
    for (let i = 0; i < cat.tables.length; i++) {
      const count = await (cat.delegates[i] as any).count();
      console.log(`   - ${cat.tables[i]}: ${count} rows`);
    }
  }

  console.log(`\nLayer 1 Checks 1 & 2 Summary: Missing Entities = ${missingEntities}`);
}

verifyLayer1().catch(console.error);
