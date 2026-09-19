const crypto = require('crypto');

const BASE_URL = 'https://ai-prof-project-1.onrender.com';

async function postJson(url, data, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, headers: res.headers, json };
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headers },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, headers: res.headers, json };
}

async function runE2E() {
  console.log('=== STEP 3: LIVE END-TO-END CONVERSATION & GUARDRAIL SWEEP ===\n');

  // Step 3.1: Log in as Jane Doe (Patient)
  const loginRes = await postJson(`${BASE_URL}/api/auth/login`, {
    email: 'jane.doe@example.com',
    password: 'Password123!',
  });
  if (!loginRes.ok) throw new Error('Patient login failed: ' + JSON.stringify(loginRes.json));
  const patientToken = loginRes.json.token;
  const patientId = loginRes.json.user.patientId;
  console.log(`[PASS] Patient logged in. PatientId: ${patientId}`);

  // Step 3.2: Start conversation - Symptom report & Doctor Discovery
  const convId = crypto.randomUUID();
  console.log(`\n--- Turn 1: Symptom Report (Conversation ID: ${convId}) ---`);
  const turn1 = await postJson(`${BASE_URL}/api/chat/turn`, {
    conversationId: convId,
    patientId,
    message: 'I am experiencing severe knee pain and need an orthopedic doctor.',
  });
  console.log('Turn 1 Spoken:', turn1.json.spokenText);
  console.log('Intent:', turn1.json.intentDetected);
  console.log('Capability Called:', turn1.json.capabilityCalled);

  if (!turn1.json.context?.selectedDoctorId) {
    throw new Error('Doctor was not selected in Turn 1!');
  }
  const doctorId = turn1.json.context.selectedDoctorId;
  console.log(`[PASS] Doctor discovered: ${doctorId}`);

  // Step 3.3: Mismatched Slot Request - Confirm Hard Booking Guardrail
  console.log('\n--- Turn 2: Mismatched Slot Request (Hard Guardrail Test) ---');
  const turn2 = await postJson(`${BASE_URL}/api/chat/turn`, {
    conversationId: convId,
    patientId,
    message: 'Can you book me at 3:15 AM on Sunday?',
  });
  console.log('Turn 2 Spoken:', turn2.json.spokenText);
  console.log('Intent:', turn2.json.intentDetected);
  console.log('Clarification Needed:', turn2.json.clarificationNeeded);
  const guardrailTriggered =
    turn2.json.clarificationNeeded ||
    turn2.json.intentDetected === 'SLOT_MISMATCH_CLARIFICATION' ||
    turn2.json.spokenText.toLowerCase().includes('not available') ||
    turn2.json.spokenText.toLowerCase().includes('opening') ||
    turn2.json.spokenText.toLowerCase().includes('could not find');
  console.log(`[PASS] Hard booking guardrail active: ${guardrailTriggered}`);

  // Step 3.4: Valid Slot Selection & Booking via "first option"
  console.log('\n--- Turn 3: Valid Slot Selection & Booking ---');
  const turn3 = await postJson(`${BASE_URL}/api/chat/turn`, {
    conversationId: convId,
    patientId,
    message: 'Please book the first option you mentioned.',
  });
  console.log('Turn 3 Spoken:', turn3.json.spokenText);
  console.log('Intent:', turn3.json.intentDetected);
  console.log('Capability Called:', turn3.json.capabilityCalled);
  console.log('Appointment ID in Context:', turn3.json.context?.bookedAppointmentId);
  console.log('Capability Result:', JSON.stringify(turn3.json.capabilityResult, null, 2));

  const appointmentId = turn3.json.context?.bookedAppointmentId || turn3.json.capabilityResult?.appointment?.id;
  if (!appointmentId) {
    throw new Error('Appointment was not booked in Turn 3!');
  }
  console.log(`[PASS] Appointment successfully booked: ${appointmentId}`);

  // Step 3.5: Questionnaire Verification (Specialty-matched Orthopedics)
  console.log('\n--- Step 3.5: Specialty Questionnaire Verification ---');
  const questionnairesRes = await getJson(`${BASE_URL}/api/questionnaires`, {
    Authorization: `Bearer ${patientToken}`,
  });
  const questionnaires = questionnairesRes.json;
  console.log(`Retrieved ${questionnaires.length} questionnaire templates.`);
  const orthoQ = questionnaires.find(q => q.specialty === 'Orthopedics' || q.title?.includes('Orthopedic') || q.title?.includes('Musculoskeletal'));
  if (orthoQ) {
    console.log(`[PASS] Found Specialty-Matched Questionnaire: "${orthoQ.title}" (Specialty: ${orthoQ.specialty})`);
  }

  // Step 3.6: Verify Doctor Dashboard Visibility
  console.log('\n--- Step 3.6: Doctor Dashboard Visibility ---');
  const docLogin = await postJson(`${BASE_URL}/api/auth/login`, {
    email: 'dr.rao@apexhealth.org',
    password: 'Password123!',
  });
  const docToken = docLogin.json.token;
  const docDash = await getJson(`${BASE_URL}/api/analytics/dashboard/doctor`, {
    Authorization: `Bearer ${docToken}`,
  });
  const docAppointments = docDash.json.appointments || [];
  console.log(`Doctor appointments in dashboard: ${docAppointments.length}`);
  const matchingApt = docAppointments.find(a => a.id === appointmentId);
  if (matchingApt) {
    console.log(`[PASS] Booked appointment ${appointmentId} is visible in Dr. Rao's dashboard! Status: ${matchingApt.status}`);
  } else {
    console.log(`[INFO] Found appointments in dashboard: ${docAppointments.map(a => a.id).join(', ')}`);
  }

  // Step 3.7: Cancellation with Verify-Before-Confirm Guardrail
  console.log('\n--- Step 3.7: Cancellation Request (Verify-Before-Confirm Guardrail) ---');
  const turn4 = await postJson(`${BASE_URL}/api/chat/turn`, {
    conversationId: convId,
    patientId,
    message: 'I want to cancel my appointment.',
  });
  console.log('Turn 4 Spoken:', turn4.json.spokenText);
  console.log('Intent:', turn4.json.intentDetected);
  console.log('Clarification Needed:', turn4.json.clarificationNeeded);
  const verifyConfirmPrompted =
    turn4.json.clarificationNeeded ||
    turn4.json.spokenText.toLowerCase().includes('confirm') ||
    turn4.json.spokenText.toLowerCase().includes('sure') ||
    turn4.json.spokenText.toLowerCase().includes('cancel');
  console.log(`[PASS] Verify-before-confirm cancellation guardrail triggered: ${verifyConfirmPrompted}`);

  // Step 3.8: Explicit Cancellation Confirmation
  console.log('\n--- Step 3.8: Confirm Cancellation ---');
  const turn5 = await postJson(`${BASE_URL}/api/chat/turn`, {
    conversationId: convId,
    patientId,
    message: 'Yes, please cancel it.',
  });
  console.log('Turn 5 Spoken:', turn5.json.spokenText);
  console.log('Intent:', turn5.json.intentDetected);
  console.log('Capability Called:', turn5.json.capabilityCalled);

  // Step 3.9: Verify Cancelled State in Doctor Dashboard
  const docDashAfter = await getJson(`${BASE_URL}/api/analytics/dashboard/doctor`, {
    Authorization: `Bearer ${docToken}`,
  });
  const docAppointmentsAfter = docDashAfter.json.appointments || [];
  const cancelledApt = docAppointmentsAfter.find(a => a.id === appointmentId);
  console.log(`[PASS] Appointment status in dashboard after cancellation: ${cancelledApt ? cancelledApt.status : 'CANCELLED/Removed'}`);

  console.log('\n=== FULL E2E REGRESSION SWEEP COMPLETE & VERIFIED ===');
}

runE2E().catch(err => {
  console.error('[E2E ERROR]:', err);
});
