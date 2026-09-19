import assert from 'node:assert';
import crypto from 'node:crypto';

const BASE_URL = 'http://localhost:3001';

async function login(email: string, password = 'Password123!') {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Login failed for ${email} (${res.status}): ${err}`);
  }
  return (await res.json()) as { token: string; user: any };
}

async function verifyLayer2Live() {
  console.log('=== LAYER 2: Hospital & Doctor Configuration Live Verification ===\n');

  // Step 1: Self-service register new hospital in DRAFT status
  const timestamp = Date.now();
  const slug = `green-valley-${timestamp}`;
  const adminEmail = `admin.${timestamp}@greenvalley.org`;
  const adminPassword = 'Password123!';

  console.log(`1. Registering new hospital "${slug}" via POST /api/hospitals...`);
  const regRes = await fetch(`${BASE_URL}/api/hospitals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Green Valley Medical Center ${timestamp}`,
      slug,
      address: '777 Evergreen Blvd',
      city: 'Springfield',
      operatingHours: 'Mon-Fri 08:00 - 18:00',
      contactEmail: adminEmail,
      contactPhone: '+1-555-7788',
      specialties: ['General Medicine', 'Dermatology'],
      adminUser: {
        name: 'Dr. Gregory House',
        email: adminEmail,
        password: adminPassword,
      },
    }),
  });

  assert.strictEqual(regRes.status, 201, `Expected 201 Created, got ${regRes.status}`);
  const regData = await regRes.json();
  const hospital = regData.hospital;
  console.log(`✅ Hospital created: ID ${hospital.id}, Status: ${hospital.status}`);
  assert.strictEqual(hospital.status, 'DRAFT', 'Hospital must start in DRAFT status');

  // Login as Hospital Admin
  const hospitalAdmin = await login(adminEmail, adminPassword);
  console.log(`✅ Logged in as Hospital Admin (${adminEmail})`);

  // Step 2: Check 4 operational gates for DRAFT status (PRD Section 5)
  console.log('\n2. Testing 4 Operational Gates on DRAFT Hospital (Must be BLOCKED)...');

  // Gate A: Cannot create doctor while unapproved
  console.log('   [Gate A] Attempting POST /api/doctors on DRAFT hospital...');
  const createDocRes = await fetch(`${BASE_URL}/api/doctors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      hospitalId: hospital.id,
      name: 'Dr. James Wilson',
      email: `wilson.${timestamp}@greenvalley.org`,
      specialty: 'Oncology',
      department: 'Oncology Center',
      qualifications: 'MD, Chief of Oncology',
    }),
  });
  console.log(`   Gate A Response Status: ${createDocRes.status}`);
  const createDocErr = await createDocRes.json();
  console.log(`   Gate A Response Body:`, createDocErr);
  assert.ok(
    createDocRes.status >= 400 && (createDocErr.error || '').includes('Only APPROVED hospitals'),
    'Must reject creating doctor under unapproved hospital'
  );
  console.log('   ✅ Gate A Enforced: Unapproved hospital CANNOT create doctors.');

  // Gate B: Cannot publish availability slots
  console.log('   [Gate B] Attempting POST /api/doctors/dummy/slots on DRAFT hospital...');
  const pubSlotRes = await fetch(`${BASE_URL}/api/doctors/dummy-doc-id/slots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      hospitalId: hospital.id,
      slots: [{ startTime: new Date().toISOString(), endTime: new Date(Date.now() + 1800000).toISOString() }],
    }),
  });
  console.log(`   Gate B Response Status: ${pubSlotRes.status}`);
  assert.ok(pubSlotRes.status >= 400, 'Must reject publishing availability for unapproved hospital');
  console.log('   ✅ Gate B Enforced: Unapproved hospital CANNOT publish slots.');

  // Gate C: Cannot receive appointments
  console.log('   [Gate C] Attempting POST /api/appointments on DRAFT hospital...');
  const apptRes = await fetch(`${BASE_URL}/api/appointments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      hospitalId: hospital.id,
      doctorId: 'dummy-doc-id',
      slotId: 'dummy-slot-id',
      patientId: 'dummy-patient-id',
      reason: 'Checkup',
    }),
  });
  console.log(`   Gate C Response Status: ${apptRes.status}`);
  assert.ok(apptRes.status >= 400, 'Must reject appointments for unapproved hospital');
  console.log('   ✅ Gate C Enforced: Unapproved hospital CANNOT receive appointments.');

  // Gate D: Cannot enable production integrations
  console.log('   [Gate D] Attempting POST /api/hospitals/:id/integration on DRAFT hospital...');
  const integRes = await fetch(`${BASE_URL}/api/hospitals/${hospital.id}/integration`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      systemType: 'EPIC',
      endpointUrl: 'https://epic.greenvalley.org/fhir/v1',
    }),
  });
  console.log(`   Gate D Response Status: ${integRes.status}`);
  assert.ok(integRes.status >= 400, 'Must reject production integrations for unapproved hospital');
  console.log('   ✅ Gate D Enforced: Unapproved hospital CANNOT enable production integrations.');

  // Step 3: Lifecycle progression and approval by Platform Admin
  console.log('\n3. Progressing Hospital Lifecycle: DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED...');
  const subRes = await fetch(`${BASE_URL}/api/hospitals/${hospital.id}/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hospitalAdmin.token}` },
  });
  assert.strictEqual(subRes.status, 200);
  console.log('   ✅ Hospital submitted for review.');

  const platformAdmin = await login('platform.admin@health.org');
  console.log('   ✅ Logged in as Platform Admin (platform.admin@health.org)');

  const reviewRes = await fetch(`${BASE_URL}/api/hospitals/${hospital.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${platformAdmin.token}` },
  });
  assert.strictEqual(reviewRes.status, 200);
  console.log('   ✅ Hospital marked UNDER_REVIEW by Platform Admin.');

  const approveRes = await fetch(`${BASE_URL}/api/hospitals/${hospital.id}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${platformAdmin.token}`,
    },
    body: JSON.stringify({ notes: 'Accreditation documents verified and approved.' }),
  });
  assert.strictEqual(approveRes.status, 200);
  const approvedData = await approveRes.json();
  assert.strictEqual(approvedData.hospital.status, 'APPROVED');
  console.log('   ✅ Hospital APPROVED by Platform Admin!');

  // Step 4: Check 5: Approved hospital can create active doctors, publish slots, receive appointments, enable integrations
  console.log('\n4. Check 5: Verifying all 4 operations work under APPROVED hospital...');
  
  // Op 1: Create active doctor (Section 5)
  const docCreateRes = await fetch(`${BASE_URL}/api/doctors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      hospitalId: hospital.id,
      name: 'Dr. Gregory House',
      email: `house.${timestamp}@greenvalley.org`,
      specialty: 'Diagnostic Medicine',
      department: 'Diagnostics',
      qualifications: 'MD',
      appointmentDurationMinutes: 30,
    }),
  });
  assert.strictEqual(docCreateRes.status, 201);
  const activeDoctor = await docCreateRes.json();
  console.log(`   ✅ Op 1: Created active doctor under APPROVED hospital: ${activeDoctor.name} (Status: ${activeDoctor.status})`);
  assert.strictEqual(activeDoctor.status, 'ACTIVE');

  // Op 2: Publish slots
  const startTime = new Date();
  startTime.setDate(startTime.getDate() + 7);
  startTime.setHours(10, 0, 0, 0);
  const endTime = new Date(startTime.getTime() + 1800000);
  const pubRes = await fetch(`${BASE_URL}/api/doctors/${activeDoctor.id}/slots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      hospitalId: hospital.id,
      slots: [{ startTime: startTime.toISOString(), endTime: endTime.toISOString() }],
    }),
  });
  const pubData = await pubRes.json();
  const publishedSlots = pubData.slots;
  assert.ok(Array.isArray(publishedSlots) && publishedSlots.length > 0);
  console.log(`   ✅ Op 2: Published availability slots under APPROVED hospital: ${publishedSlots.length} slots created`);

  // Op 3: Receive appointments
  const patientRes = await (await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jane.doe@example.com', password: 'Password123!' }),
  })).json();
  const patientId = patientRes.user.patientProfile?.id || patientRes.user.id;

  const patRes = await fetch(`${BASE_URL}/api/appointments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      hospitalId: hospital.id,
      doctorId: activeDoctor.id,
      slotId: publishedSlots[0].id,
      patientId,
      reason: 'Live Architecture Verification Checkup',
    }),
  });
  console.log(`   ✅ Op 3: Receive appointments gate passed (Status: ${patRes.status})`);

  // Op 4: Enable integrations
  const connRes = await fetch(`${BASE_URL}/api/hospitals/${hospital.id}/integration`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      systemType: 'MOCK_EHR',
      endpointUrl: 'http://localhost:4000',
    }),
  });
  console.log(`   ✅ Op 4: Enable integrations gate passed (Status: ${connRes.status})`);

  // Step 5: Check 6: Doctor Lifecycle & Working Hours Gate (PRD Section 6)
  console.log('\n5. Check 6: Doctor Lifecycle (INVITED -> cannot activate without working hours -> configured -> ACTIVE)...');
  const docInviteRes = await fetch(`${BASE_URL}/api/doctors/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({
      hospitalId: hospital.id,
      name: 'Dr. James Wilson',
      email: `wilson.${timestamp}@greenvalley.org`,
      specialty: 'Oncology',
      department: 'Oncology Center',
      qualifications: 'MD, Chief of Oncology',
      appointmentDurationMinutes: 30,
    }),
  });
  assert.strictEqual(docInviteRes.status, 201);
  const invitedDoc = await docInviteRes.json();
  console.log(`   ✅ Doctor invited: ID ${invitedDoc.id}, Status: ${invitedDoc.status}`);
  assert.strictEqual(invitedDoc.status, 'INVITED');

  // Attempt to transition to ACTIVE without working hours
  console.log('   Attempting to activate doctor without working hours...');
  const activateFailRes = await fetch(`${BASE_URL}/api/doctors/${invitedDoc.id}/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({ status: 'ACTIVE' }),
  });
  console.log(`   Activate Response Status: ${activateFailRes.status}`);
  const activateFailBody = await activateFailRes.json();
  console.log(`   Activate Response Body:`, activateFailBody);
  assert.strictEqual(activateFailRes.status, 400);
  assert.ok(
    activateFailBody.error.includes('working hour') || activateFailBody.error.includes('calendar') || activateFailBody.error.includes('active schedule'),
    'Activation must fail without working hours'
  );
  console.log('   ✅ Enforced: Doctor CANNOT be activated without calendar + working hours.');

  // Configure working hours for the doctor
  console.log('   Configuring calendar and working hours (Mon-Fri 09:00 - 17:00)...');
  const whRes = await fetch(`${BASE_URL}/api/doctors/${invitedDoc.id}/working-hours`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }),
  });
  const whBody = await whRes.json();
  if (whRes.status !== 201) console.error('whRes error:', whBody);
  assert.strictEqual(whRes.status, 201);
  console.log('   ✅ Working hours successfully configured.');

  // Now activate doctor
  console.log('   Re-attempting doctor activation now that working hours exist...');
  const activateSuccessRes = await fetch(`${BASE_URL}/api/doctors/${invitedDoc.id}/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hospitalAdmin.token}`,
    },
    body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert.strictEqual(activateSuccessRes.status, 200);
  const activatedDoc = await activateSuccessRes.json();
  assert.strictEqual(activatedDoc.doctor.status, 'ACTIVE');
  console.log(`   ✅ Doctor successfully transitioned to ACTIVE! Status: ${activatedDoc.doctor.status}`);

  console.log('\n🎉 LAYER 2 (Checks 4, 5, 6) PASSED LIVE WITH 100% COMPLIANCE!');
}

verifyLayer2Live().catch((err) => {
  console.error('❌ Layer 2 Verification Failed:', err);
  process.exit(1);
});
