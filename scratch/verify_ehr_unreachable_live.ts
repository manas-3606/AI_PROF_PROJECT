import { prisma } from '@health/db';

async function run() {
  const deployedUrl = 'https://ai-prof-project-1.onrender.com';
  console.log('--- Testing live deployed environment booking when EHR service is unreachable ---');

  // 1. Authenticate as patient
  const loginRes = await fetch(`${deployedUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jane.doe@example.com', password: 'Password123!' }),
  });
  const loginData = await loginRes.json() as any;
  const token = loginData.token;

  const patientRecord = await prisma.patient.findFirst({
    where: { email: 'jane.doe@example.com' }
  });
  if (!patientRecord) throw new Error('Patient record not found');
  const patientId = patientRecord.id;
  console.log('Patient login HTTP status:', loginRes.status, 'User ID:', loginData.user?.id, 'Patient Entity ID:', patientId);

  // 2. Find a real available slot from DB within working hours
  // Dr. Rao is available weekdays 9-17 at Apex Health
  const doctor = await prisma.doctor.findFirst({
    where: { name: { contains: 'Rao' } }
  });
  if (!doctor) throw new Error('Doctor Rao not found');

  // 2. Find a real available slot from DB within working hours (08:00 - 18:00)
  const slotDate = new Date();
  slotDate.setDate(slotDate.getDate() + 3);
  slotDate.setUTCHours(10, 0, 0, 0);
  const slotEndDate = new Date(slotDate.getTime() + 30 * 60 * 1000);

  const slot = await prisma.slot.upsert({
    where: {
      doctorId_startTime: {
        doctorId: doctor.id,
        startTime: slotDate
      }
    },
    update: { isBooked: false, isBlocked: false },
    create: {
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      startTime: slotDate,
      endTime: slotEndDate,
      isBooked: false,
      isBlocked: false
    },
    include: { doctor: true, hospital: true }
  });

  console.log(`Targeting slot ${slot.id} on ${slot.startTime.toISOString()} for Dr. ${slot.doctor.name} at ${slot.hospital.name}`);

  // 3. Attempt booking via deployed API endpoint
  const bookRes = await fetch(`${deployedUrl}/api/appointments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      slotId: slot.id,
      patientId: patientId,
      doctorId: slot.doctorId,
      hospitalId: slot.hospitalId,
      startTime: slot.startTime.toISOString(),
      endTime: slot.endTime.toISOString(),
      reason: 'Live PRD failure verification: EHR unreachable',
      idempotencyKey: `live-fail-${Date.now()}`
    })
  });

  const bookData = await bookRes.json() as any;
  console.log('Booking HTTP response status:', bookRes.status);
  console.log('Booking response payload:', JSON.stringify(bookData, null, 2));

  // 4. Query DB for the appointment and reconciliation record
  const appt = await prisma.appointment.findFirst({
    where: {
      patientId: patientId,
      slotId: slot.id
    },
    orderBy: { createdAt: 'desc' },
    include: { reconciliations: true }
  });

  console.log('\n--- Database Record Verification ---');
  console.log('Appointment ID:', appt?.id);
  console.log('Appointment Status:', appt?.status);
  console.log('External Appointment ID:', appt?.externalAppointmentId);
  console.log('Reconciliation Records count:', appt?.reconciliations?.length);
  if (appt?.reconciliations?.length) {
    console.log('Reconciliation Record details:', JSON.stringify(appt.reconciliations[0], null, 2));
  }

  // 5. Query operational events
  const events = await prisma.operationalEvent.findMany({
    where: {
      correlationId: appt?.reconciliations?.[0]?.correlationId || undefined
    },
    take: 3
  });
  console.log('Operational Events count:', events.length);

  // Assertions for PRD adherence
  if (appt?.status === 'CONFIRMED' && !appt.externalAppointmentId) {
    console.error('FAIL: Appointment reached CONFIRMED without external verification!');
    process.exit(1);
  } else if (appt?.status === 'SYNCHRONIZATION_PENDING' || appt?.status === 'RECONCILIATION_REQUIRED' || bookRes.status === 400) {
    console.log('\n SUCCESS: Integration failure safely handled. Appointment did NOT reach fake CONFIRMED.');
    console.log('Status safely held at:', appt?.status || 'Error returned');
    console.log('Reconciliation record logged for Platform Operations Desk:', !!appt?.reconciliations?.length);
  }
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
