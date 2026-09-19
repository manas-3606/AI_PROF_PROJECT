import { prisma } from '@health/db';
import { CapabilityRegistry } from '@health/capabilities';
import { PatientAccessAgent } from '../packages/capabilities/src/patient-agent.js';
import { AppointmentStatus } from '@health/shared-types';
import crypto from 'node:crypto';

async function runFinalScenario() {
  console.log('================================================================');
  console.log('STARTING FINAL LIVE VERIFICATION SCENARIO');
  console.log('================================================================\n');

  // 1. Retrieve Dr. Elena Jenkins & Metropolitan General Hospital
  const doctor = await prisma.doctor.findFirst({
    where: { name: { contains: 'Jenkins' } },
    include: { hospital: true },
  });

  if (!doctor) {
    throw new Error('Dr. Jenkins not found in database');
  }

  const patient = await prisma.patient.findFirst({
    where: { name: { contains: 'Jane' } },
  });

  if (!patient) {
    throw new Error('Patient Jane not found in database');
  }

  console.log(`[SETUP] Hospital: ${doctor.hospital.name} (${doctor.hospitalId})`);
  console.log(`[SETUP] Doctor: ${doctor.name} (${doctor.id}), Specialty: ${doctor.specialty}`);
  console.log(`[SETUP] Patient: ${patient.name} (${patient.id})\n`);

  const conversationId = `final-scenario-${Date.now()}`;
  const agent = new PatientAccessAgent({
    conversationId,
    patientId: patient.id,
    hospitalId: doctor.hospitalId,
  });

  // STEP 1: Conversational symptom triage & doctor search
  console.log('--- STEP 1: Conversational Symptom Triage & Doctor Recommendation ---');
  const utterance1 = 'I have had a severe sore throat and fever for two days.';
  console.log(`[PATIENT]: "${utterance1}"`);
  
  const turn1 = await agent.processTurn(utterance1);
  console.log(`[AGENT]: "${turn1.responseText}"\n`);

  // Find an available slot for Dr. Jenkins
  const availableSlot = await prisma.slot.findFirst({
    where: {
      doctorId: doctor.id,
      isBooked: false,
    },
    orderBy: { startTime: 'asc' },
  });

  if (!availableSlot) {
    throw new Error('No available slot found for Dr. Jenkins');
  }

  console.log(`[SLOT DISCOVERY]: Found slot ${availableSlot.id} at ${availableSlot.startTime.toISOString()}`);

  // STEP 2: Booking the appointment
  console.log('\n--- STEP 2: Book Appointment with Dr. Jenkins ---');
  const booking = await CapabilityRegistry.execute(
    'create_appointment',
    {
      patientId: patient.id,
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      slotId: availableSlot.id,
      reason: 'Severe sore throat and fever',
      idempotencyKey: crypto.randomUUID(),
    },
    {
      actorRole: 'PATIENT',
      patientId: patient.id,
      tenantId: doctor.hospitalId,
    }
  );

  console.log(`[BOOKING RESULT]: Appointment ID: ${booking.appointmentId}, Status: ${booking.status}`);
  const appointmentId = booking.appointmentId;

  // DB Verification of Step 2
  const bookedAppt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });
  console.log(`[DB RECORD]: Appointment Status: ${bookedAppt?.status}`);
  console.log(`[DB RECORD]: External EHR ID: ${bookedAppt?.externalAppointmentId}`);
  
  const slotAfterBooking = await prisma.slot.findUnique({
    where: { id: availableSlot.id },
  });
  console.log(`[DB RECORD]: Doctor Slot isBooked: ${slotAfterBooking?.isBooked}`);

  if (bookedAppt?.status !== AppointmentStatus.CONFIRMED || !slotAfterBooking?.isBooked) {
    throw new Error('Booking verification failed: Expected CONFIRMED and isBooked: true');
  }

  // STEP 3: Intake Questionnaire Retrieval (BUG 2 Verification)
  console.log('\n--- STEP 3: Retrieve Specialty-Matched Intake Questionnaire (BUG 2) ---');
  const qResult = await CapabilityRegistry.execute(
    'get_questionnaire',
    {
      hospitalId: doctor.hospitalId,
      doctorId: doctor.id,
      appointmentId: appointmentId,
    },
    {
      actorRole: 'PATIENT',
      tenantId: doctor.hospitalId,
    }
  );

  console.log(`[QUESTIONNAIRE TITLE]: "${qResult.questionnaire?.title}"`);
  const questions = qResult.questionnaire?.schema || [];
  console.log(`[QUESTION COUNT]: ${questions.length} questions`);

  if (!qResult.questionnaire?.title.toLowerCase().includes('general medicine')) {
    throw new Error(`BUG 2 Regression: Expected General Medicine questionnaire, got: ${qResult.questionnaire?.title}`);
  }

  // STEP 4: Submit Questionnaire Responses
  console.log('\n--- STEP 4: Patient Completes Pre-Visit Questionnaire ---');
  const responsesRecord: Record<string, any> = {};
  for (const q of questions) {
    console.log(` - Question [${q.fieldId}] (${q.type}): "${q.question}"`);
    let ans = 'Mild discomfort';
    const qLower = q.question.toLowerCase();
    if (qLower.includes('symptom') || qLower.includes('chief') || qLower.includes('reason')) {
      ans = 'Severe sore throat and high fever';
    } else if (qLower.includes('duration') || qLower.includes('long')) {
      ans = '2 days';
    } else if (qLower.includes('medication') || qLower.includes('allergy') || qLower.includes('taking')) {
      ans = 'No ongoing medications or known allergies';
    } else if (q.type === 'NUMBER' || qLower.includes('temperature') || qLower.includes('fever')) {
      ans = '101.5 F';
    } else if (q.type === 'RATING_SCALE' || qLower.includes('severity') || qLower.includes('pain') || qLower.includes('rate')) {
      ans = '7';
    }
    responsesRecord[q.fieldId] = ans;
  }

  const submitResult = await CapabilityRegistry.execute(
    'submit_questionnaire',
    {
      appointmentId: appointmentId,
      questionnaireId: qResult.questionnaire.id,
      patientId: patient.id,
      responses: responsesRecord,
    },
    {
      actorRole: 'PATIENT',
      patientId: patient.id,
      tenantId: doctor.hospitalId,
    }
  );

  console.log(`[SUBMIT RESULT]: Completed: ${submitResult.completed}, Stored Responses: ${submitResult.responseCount}`);

  // STEP 5: Doctor Dashboard Human-Readable Check (BUG 3 Verification)
  console.log('\n--- STEP 5: Doctor Dashboard Human-Readable Verification (BUG 3) ---');
  const res = await fetch(`http://localhost:3001/api/analytics/dashboard/doctor?doctorId=${doctor.id}`, {
    headers: {
      Authorization: `Bearer mock-doctor-token`,
      'x-tenant-id': doctor.hospitalId,
    },
  });

  if (!res.ok) {
    throw new Error(`Doctor dashboard API returned status ${res.status}`);
  }

  const dashData = await res.json();
  const qMap = dashData.questionTextMap || dashData.data?.questionTextMap || {};
  console.log(`[DASHBOARD API]: questionTextMap contains ${Object.keys(qMap).length} mapped question definitions.`);

  // Verify that every question from the submitted questionnaire is in the map
  for (const [fId, val] of Object.entries(responsesRecord)) {
    const label = qMap[fId];
    console.log(`  * Question ID: ${fId} => Label: "${label}" | Answer: "${val}"`);
    if (!label) {
      throw new Error(`BUG 3 Regression: Question ID ${fId} was not mapped in doctor dashboard!`);
    }
  }

  // STEP 6: Cancellation with Synchronization Pending & Verification (BUG 1 Verification)
  console.log('\n--- STEP 6: Cancellation with Synchronization Pending & Verification (BUG 1) ---');
  console.log(`[PATIENT]: "I need to cancel my appointment with Dr. Jenkins"`);

  const cancelResult = await CapabilityRegistry.execute(
    'cancel_appointment',
    {
      appointmentId: appointmentId,
      reason: 'Patient resolved condition / schedule conflict',
      idempotencyKey: crypto.randomUUID(),
    },
    {
      actorRole: 'PATIENT',
      patientId: patient.id,
      tenantId: doctor.hospitalId,
    }
  );

  console.log(`[CANCELLATION RESULT]: Status: ${cancelResult.status}, slotReleased: ${cancelResult.slotReleased}`);

  // DB Verification of Cancellation
  const cancelledAppt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });
  console.log(`[DB RECORD]: Appointment Final Status: ${cancelledAppt?.status}`);

  const slotAfterCancel = await prisma.slot.findUnique({
    where: { id: availableSlot.id },
  });
  console.log(`[DB RECORD]: Doctor Slot isBooked: ${slotAfterCancel?.isBooked}`);

  // Check Notifications
  const patientSms = await prisma.notification.findFirst({
    where: {
      recipientId: patient.id,
      channel: 'sms',
      templateId: 'APPOINTMENT_CANCELLED_CONFIRMATION',
    },
    orderBy: { createdAt: 'desc' },
  });

  const doctorAlert = await prisma.notification.findFirst({
    where: {
      recipientId: doctor.id,
      channel: 'in_app',
      templateId: 'APPOINTMENT_CANCELLED_ALERT',
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`[NOTIFICATIONS]: Patient SMS Dispatched: ${patientSms ? 'YES' : 'NO'}`);
  if (patientSms) console.log(`   Payload: "${patientSms.payloadJson}"`);

  console.log(`[NOTIFICATIONS]: Doctor In-App Alert Dispatched: ${doctorAlert ? 'YES' : 'NO'}`);
  if (doctorAlert) console.log(`   Payload: "${doctorAlert.payloadJson}"`);

  // Check Transition History
  const history = await prisma.appointmentStateHistory.findMany({
    where: { appointmentId: appointmentId },
    orderBy: { changedAt: 'asc' },
  });

  console.log('\n[STATE TRANSITION AUDIT TRAIL]:');
  for (const h of history) {
    console.log(`  ${h.fromStatus} -> ${h.toStatus} (${h.reason}) at ${h.changedAt.toISOString()}`);
  }

  const hasPending = history.some(h => h.toStatus === AppointmentStatus.SYNCHRONIZATION_PENDING || h.fromStatus === AppointmentStatus.SYNCHRONIZATION_PENDING);
  const hasCancelled = history.some(h => h.toStatus === AppointmentStatus.CANCELLED);

  if (!hasPending || !hasCancelled) {
    throw new Error('BUG 1 Regression: Expected transition through SYNCHRONIZATION_PENDING to CANCELLED');
  }

  if (slotAfterCancel?.isBooked !== false) {
    throw new Error('BUG 1 Regression: Doctor slot was not freed (isBooked is still true)');
  }

  if (!patientSms || !doctorAlert) {
    throw new Error('BUG 1 Regression: Missing cancellation notifications for patient SMS or doctor alert');
  }

  console.log('\n================================================================');
  console.log('FINAL LIVE VERIFICATION SCENARIO COMPLETED: 100% PASS');
  console.log('================================================================');
}

runFinalScenario()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Final Scenario Error:', err);
    process.exit(1);
  });
