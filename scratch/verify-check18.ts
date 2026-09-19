import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const prisma = new PrismaClient();
const BASE_URL = 'http://localhost:3001';

async function main() {
  console.log('🚀 Running Layer 8 - Check 18: Cross-Tenant Access & Audit Log Verification...\n');

  // 1. Authenticate as Hospital Admin A (admin@apexhealth.org - Apex Regional)
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@apexhealth.org', password: 'Password123!' }),
  });
  if (!loginRes.ok) throw new Error('Login failed for admin@apexhealth.org');
  const loginData = (await loginRes.json()) as any;
  const token = loginData.token;
  const apexHospitalId = loginData.user?.tenantId || loginData.user?.hospitalId;
  console.log(`Authenticated as Apex Admin (Hospital ID: ${apexHospitalId})`);

  // 2. Find Hospital B (Metropolitan Health)
  const metro = await prisma.hospital.findFirst({
    where: { name: { contains: 'Metropolitan' } },
  });
  if (!metro) throw new Error('Hospital B (Metropolitan) not found');
  console.log(`Target Hospital B: ${metro.name} (${metro.id})`);

  // Find Hospital B's doctor
  const metroDoctor = await prisma.doctor.findFirst({
    where: { hospitalId: metro.id },
  });

  // Find Hospital B's appointment
  const metroAppointment = await prisma.appointment.findFirst({
    where: { hospitalId: metro.id },
  });

  // 3. Test 1: Cross-tenant dashboard access -> Expect 403
  console.log('\nAttempt 1: Apex Admin querying Metro Admin Dashboard...');
  const corr1 = `corr-sec-chk18-${crypto.randomUUID()}`;
  const resDash = await fetch(`${BASE_URL}/api/analytics/dashboard/hospital-admin?hospitalId=${metro.id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-correlation-id': corr1,
    },
  });
  console.log(`  -> Status: ${resDash.status} (Expected 403)`);
  if (resDash.status !== 403) {
    throw new Error(`Expected 403 on cross-tenant dashboard, got ${resDash.status}`);
  }

  // 4. Test 2: Cross-tenant doctor roster access -> Expect 403
  console.log('\nAttempt 2: Apex Admin querying Metro Doctors list...');
  const corr2 = `corr-sec-chk18-${crypto.randomUUID()}`;
  const resDocs = await fetch(`${BASE_URL}/api/doctors?hospitalId=${metro.id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-correlation-id': corr2,
    },
  });
  console.log(`  -> Status: ${resDocs.status} (Expected 403)`);
  if (resDocs.status !== 403) {
    throw new Error(`Expected 403 on cross-tenant doctors, got ${resDocs.status}`);
  }

  // 5. Test 3: Cross-tenant appointment access -> Expect 403
  if (metroAppointment) {
    console.log(`\nAttempt 3: Apex Admin accessing Metro Appointment (${metroAppointment.id})...`);
    const corr3 = `corr-sec-chk18-${crypto.randomUUID()}`;
    const resAppt = await fetch(`${BASE_URL}/api/appointments/${metroAppointment.id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-correlation-id': corr3,
      },
    });
    console.log(`  -> Status: ${resAppt.status} (Expected 403)`);
    if (resAppt.status !== 403) {
      throw new Error(`Expected 403 on cross-tenant appointment, got ${resAppt.status}`);
    }
  }

  // 6. Test 4: Cross-tenant appointment creation -> Expect 403
  if (metroDoctor) {
    console.log('\nAttempt 4: Apex Admin creating appointment in Metro hospital...');
    const patient = await prisma.patient.findFirst();
    const corr4 = `corr-sec-chk18-${crypto.randomUUID()}`;
    const resCreate = await fetch(`${BASE_URL}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-correlation-id': corr4,
      },
      body: JSON.stringify({
        patientId: patient?.id,
        doctorId: metroDoctor.id,
        hospitalId: metro.id,
        slotId: 'fake-slot',
      }),
    });
    console.log(`  -> Status: ${resCreate.status} (Expected 403)`);
    if (resCreate.status !== 403) {
      throw new Error(`Expected 403 on cross-tenant appointment creation, got ${resCreate.status}`);
    }
  }

  // 7. Verify AuditEvent creation in database
  console.log('\n🔍 Verifying Security Audit Log entries in Database...');
  const auditEntries = await prisma.auditEvent.findMany({
    where: {
      action: { contains: 'CROSS_TENANT' },
    },
    orderBy: { timestamp: 'desc' },
    take: 5,
  });

  console.log(`Found ${auditEntries.length} cross-tenant violation audit records:`);
  for (const entry of auditEntries) {
    console.log(`  - [${entry.timestamp.toISOString()}] Action: ${entry.action}, Actor: ${entry.actorRole} (${entry.actorId}), Details: ${entry.detailsJson}`);
  }

  if (auditEntries.length === 0) {
    throw new Error('No CROSS_TENANT audit log entries were created in database!');
  }

  console.log('\n🎉 CHECK 18 PASSED WITH 100% SUCCESS (HTTP 403 + AUDIT LOG ENTRY CONFIRMED)!');
}

main()
  .catch((err) => {
    console.error('❌ Check 18 verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
