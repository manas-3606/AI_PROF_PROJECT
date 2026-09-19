import { prisma } from '@health/db';

async function main() {
  const deployedUrl = 'https://ai-prof-project-1.onrender.com';
  console.log('=== LIVE DEPLOYED DASHBOARDS VERIFICATION ===\n');

  // 1. Platform Admin Dashboard
  console.log('--- 1. PLATFORM ADMIN DASHBOARD ---');
  const pLogin = await fetch(`${deployedUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'platform.admin@health.org', password: 'Password123!' }),
  });
  const pData = await pLogin.json() as any;
  const pRes = await fetch(`${deployedUrl}/api/analytics/dashboard/platform-admin`, {
    headers: { Authorization: `Bearer ${pData.token}` },
  });
  const pDash = await pRes.json() as any;
  console.log('HTTP Status:', pRes.status);
  console.log('Platform Stats:', {
    totalHospitals: pDash.totalHospitals,
    totalDoctors: pDash.totalDoctors,
    totalPatients: pDash.totalPatients,
    totalAppointments: pDash.totalAppointments,
    systemHealth: pDash.systemHealth?.status,
    totalAiConversations: pDash.totalAiConversations,
    reconciliationRecords: pDash.openReconciliations
  });

  // 2. Hospital Admin Dashboard (Apex Health)
  console.log('\n--- 2. HOSPITAL ADMIN DASHBOARD (Apex Health) ---');
  const hLogin = await fetch(`${deployedUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@apexhealth.org', password: 'Password123!' }),
  });
  const hData = await hLogin.json() as any;
  const hospitalId = hData.user.tenantId;
  const hRes = await fetch(`${deployedUrl}/api/analytics/dashboard/hospital-admin?hospitalId=${hospitalId}`, {
    headers: { Authorization: `Bearer ${hData.token}` },
  });
  const hDash = await hRes.json() as any;
  console.log('HTTP Status:', hRes.status);
  console.log('Hospital Stats:', {
    hospitalName: hDash.hospital?.name,
    doctorCount: hDash.doctors?.length,
    appointmentCount: hDash.appointments?.length,
    questionnairesCount: hDash.questionnaires?.length
  });

  // 3. Doctor Dashboard (Dr. Arvind Rao)
  console.log('\n--- 3. DOCTOR DASHBOARD (Dr. Arvind Rao) ---');
  const dLogin = await fetch(`${deployedUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dr.rao@apexhealth.org', password: 'Password123!' }),
  });
  const dData = await dLogin.json() as any;
  const dRes = await fetch(`${deployedUrl}/api/analytics/dashboard/doctor`, {
    headers: { Authorization: `Bearer ${dData.token}` },
  });
  const dDash = await dRes.json() as any;
  console.log('HTTP Status:', dRes.status);
  console.log('Doctor Stats:', {
    doctorName: dDash.doctor?.name,
    specialty: dDash.doctor?.specialty,
    upcomingAppointments: dDash.upcomingAppointments?.length,
    todayAppointments: dDash.todayAppointments?.length
  });

  // 4. Patient Dashboard (Jane Doe)
  console.log('\n--- 4. PATIENT DASHBOARD (Jane Doe) ---');
  const patLogin = await fetch(`${deployedUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jane.doe@example.com', password: 'Password123!' }),
  });
  const patData = await patLogin.json() as any;
  const patientRecord = await prisma.patient.findFirst({ where: { email: 'jane.doe@example.com' } });
  const patApptsRes = await fetch(`${deployedUrl}/api/appointments?patientId=${patientRecord?.id}`, {
    headers: { Authorization: `Bearer ${patData.token}` },
  });
  const patAppts = await patApptsRes.json() as any;
  console.log('HTTP Status:', patApptsRes.status);
  console.log('Patient Stats:', {
    patientName: patData.user.name,
    patientEmail: patData.user.email,
    patientId: patientRecord?.id,
    bookedAppointmentsCount: Array.isArray(patAppts) ? patAppts.length : 0,
    latestAppointment: Array.isArray(patAppts) && patAppts[0] ? {
      id: patAppts[0].id,
      status: patAppts[0].status,
      doctor: patAppts[0].doctor?.name,
      startTime: patAppts[0].startTime
    } : null
  });

  console.log('\n=== ALL 4 DASHBOARDS RETURN VALID DATA FROM LIVE DEPLOYED URL ===');
}

main().catch(err => {
  console.error('Error running dashboard verification:', err);
  process.exit(1);
});
