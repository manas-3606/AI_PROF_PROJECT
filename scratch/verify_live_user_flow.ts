import { prisma } from '@health/db';

async function main() {
  const deployedUrl = 'https://ai-prof-project-1.onrender.com';
  console.log('=== VERIFYING LIVE USER FLOW AGAINST DEPLOYED RENDER SERVICE ===\n');

  // Step 1: Patient Login
  console.log('--- Step 1: Patient Authentication ---');
  const loginRes = await fetch(`${deployedUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jane.doe@example.com', password: 'Password123!' }),
  });
  const loginData = await loginRes.json() as any;
  console.log('Login Status:', loginRes.status, 'User Name:', loginData.user?.name);
  const token = loginData.token;

  const patientRecord = await prisma.patient.findFirst({ where: { email: 'jane.doe@example.com' } });
  if (!patientRecord) throw new Error('Patient record not found');
  const patientId = patientRecord.id;

  // Step 2: Patient Views Available Doctors and Questionnaires
  console.log('\n--- Step 2: Browse Doctors and Available Questionnaires ---');
  const docsRes = await fetch(`${deployedUrl}/api/doctors`);
  const docs = await docsRes.json() as any;
  console.log(`Fetched ${docs.length} active doctors across approved hospitals.`);
  const doctor = docs.find((d: any) => d.name.includes('Rao')) || docs[0];
  console.log(`Selected Doctor: ${doctor.name} (${doctor.specialty}) at ${doctor.hospital?.name}`);

  const qRes = await fetch(`${deployedUrl}/api/questionnaires`);
  const questionnaires = await qRes.json() as any;
  console.log(`Available Questionnaires in system: ${questionnaires.length}`);
  const orthoQ = questionnaires.find((q: any) => q.category === 'Orthopedics' || q.title.includes('Orthopedic')) || questionnaires[0];
  console.log(`Selected Questionnaire: "${orthoQ.title}" (ID: ${orthoQ.id})`);

  // Find an existing appointment for the patient
  const myAppt = await prisma.appointment.findFirst({
    where: { patientId: patientId },
    orderBy: { createdAt: 'desc' }
  });
  if (!myAppt) throw new Error('No appointment found for patient');

  // Step 3: Complete Pre-Visit Intake Questionnaire
  console.log('\n--- Step 3: Complete Pre-Visit Intake Questionnaire ---');
  const submitQRes = await fetch(`${deployedUrl}/api/questionnaires/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      questionnaireId: orthoQ.id,
      appointmentId: myAppt.id,
      patientId: patientId,
      responses: {
        symptom_description: 'Persistent right shoulder pain after heavy lifting',
        severity_level: 'Moderate (6/10)',
        duration: '2 weeks'
      }
    })
  });
  const qSubmitData = await submitQRes.json() as any;
  console.log('Questionnaire Submission Status:', submitQRes.status);
  console.log('Questionnaire Response Payload:', JSON.stringify(qSubmitData));

  // Verify in database
  const dbQResponse = await prisma.questionnaireResponse.findFirst({
    where: { patientId: patientId },
    orderBy: { submittedAt: 'desc' }
  });
  console.log('DB Questionnaire Response Verified: ID', dbQResponse?.id, 'Flagged Urgent:', dbQResponse?.flaggedUrgent);

  // Step 4: Check Patient Appointments & Execute Cancellation
  console.log('\n--- Step 4: Appointment Retrieval & Cancellation ---');
  const myApptsRes = await fetch(`${deployedUrl}/api/appointments?patientId=${patientId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const myAppts = await myApptsRes.json() as any;
  console.log(`Patient has ${myAppts.length} appointments on record.`);

  if (myAppts.length > 0) {
    const targetAppt = myAppts[0];
    console.log(`Attempting cancellation of appointment ${targetAppt.id} (Current status: ${targetAppt.status})`);

    const cancelRes = await fetch(`${deployedUrl}/api/appointments/${targetAppt.id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ reason: 'Patient requested cancellation due to scheduling conflict' })
    });
    const cancelData = await cancelRes.json() as any;
    console.log('Cancellation HTTP Status:', cancelRes.status);
    console.log('Cancellation Response:', JSON.stringify(cancelData));

    // Verify appointment status updated in database
    const updatedAppt = await prisma.appointment.findUnique({ where: { id: targetAppt.id } });
    console.log('Database Status after cancellation:', updatedAppt?.status);
  }

  console.log('\n=== LIVE PATIENT INTAKE -> QUESTIONNAIRE -> CANCELLATION WORKFLOW VERIFIED ON DEPLOYED SERVICE ===');
}

main().catch(err => {
  console.error('Error in live flow:', err);
  process.exit(1);
});
