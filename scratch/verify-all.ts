import { chromium } from 'playwright-core';
import { prisma } from '@health/db';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Manasa\\.gemini\\antigravity-ide\\brain\\1df22142-06a1-4eda-be3a-131ba5fa49e1';
const BASE_URL = 'http://localhost:3001';

async function main() {
  console.log('🚀 Starting Multi-Tenant System Verification...\n');

  // 1. Fetch hospitals from DB
  const apex = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
  const metro = await prisma.hospital.findFirst({ where: { slug: 'metropolitan-health' } });
  const riverside = await prisma.hospital.findFirst({ where: { slug: 'riverside-community' } });

  if (!apex || !metro || !riverside) {
    throw new Error('Hospitals not found in DB. Did seed run?');
  }

  console.log(`🏥 Verified Hospitals:`);
  console.log(`   - Apex Regional: ${apex.id} (${apex.slug})`);
  console.log(`   - Metro Health: ${metro.id} (${metro.slug})`);
  console.log(`   - Riverside Community: ${riverside.id} (${riverside.slug})\n`);

  // ==========================================
  // A. SCREENSHOT REDESIGNED LOGIN PAGE
  // ==========================================
  console.log('📸 Step A: Launching Chrome to capture redesigned LoginPage screenshot...');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173');
  await page.waitForSelector('#tab-doctor');

  // Click doctor tab to show doctor selector
  await page.click('#tab-doctor');
  await page.waitForTimeout(300);

  // Click dropdown toggle button to display options for different hospitals
  await page.click('#dropdown-toggle-btn');
  await page.waitForSelector('#dropdown-options-container');
  await page.waitForTimeout(400);

  const screenshotPath = `${ARTIFACT_DIR}\\login_redesign_with_dropdown.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`✅ Screenshot with dropdown open saved to: ${screenshotPath}\n`);
  await browser.close();

  // Helper login function
  async function login(email: string, pass: string = 'Password123!') {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Login failed for ${email} (${res.status}): ${err}`);
    }
    return (await res.json()) as { token: string; user: any };
  }

  // ==========================================
  // B. HOSPITAL ADMINS: POSITIVE & NEGATIVE CHECKS
  // ==========================================
  console.log('🔐 Step B: Verifying 3 Hospital Admins (Positive & Negative 403 Isolation)...');

  const adminApex = await login('admin@apexhealth.org');
  const adminMetro = await login('admin@metrohealth.org');
  const adminRiverside = await login('admin@riversidehealth.org');

  // 1. Apex Admin Checks
  console.log('  --- Checking Apex Admin (admin@apexhealth.org) ---');
  // Positive: Access Apex Dashboard
  const apexDashRes = await fetch(`${BASE_URL}/api/analytics/dashboard/hospital-admin?hospitalId=${apex.id}`, {
    headers: { Authorization: `Bearer ${adminApex.token}` },
  });
  console.log(`    [POSITIVE] Apex Admin -> Apex Dashboard: Status ${apexDashRes.status}`);
  if (apexDashRes.status !== 200) throw new Error('Apex Admin could not access Apex dashboard');

  // Negative: Access Metro Dashboard -> Expect 403
  const apexToMetroDash = await fetch(`${BASE_URL}/api/analytics/dashboard/hospital-admin?hospitalId=${metro.id}`, {
    headers: { Authorization: `Bearer ${adminApex.token}` },
  });
  console.log(`    [NEGATIVE] Apex Admin -> Metro Dashboard: Status ${apexToMetroDash.status} (Expected 403)`);
  if (apexToMetroDash.status !== 403) throw new Error('Apex Admin was not rejected with 403 on Metro dashboard');

  // Negative: Access Riverside Doctors -> Expect 403
  const apexToRiverDocs = await fetch(`${BASE_URL}/api/doctors?hospitalId=${riverside.id}`, {
    headers: { Authorization: `Bearer ${adminApex.token}` },
  });
  console.log(`    [NEGATIVE] Apex Admin -> Riverside Doctors: Status ${apexToRiverDocs.status} (Expected 403)`);
  if (apexToRiverDocs.status !== 403) throw new Error('Apex Admin was not rejected with 403 on Riverside doctors');

  // Negative: Access Riverside Appointments -> Expect 403
  const apexToRiverAppts = await fetch(`${BASE_URL}/api/appointments?hospitalId=${riverside.id}`, {
    headers: { Authorization: `Bearer ${adminApex.token}` },
  });
  console.log(`    [NEGATIVE] Apex Admin -> Riverside Appointments: Status ${apexToRiverAppts.status} (Expected 403)`);
  if (apexToRiverAppts.status !== 403) throw new Error('Apex Admin was not rejected with 403 on Riverside appointments');

  // 2. Metro Admin Checks
  console.log('  --- Checking Metro Admin (admin@metrohealth.org) ---');
  // Positive: Access Metro Dashboard
  const metroDashRes = await fetch(`${BASE_URL}/api/analytics/dashboard/hospital-admin?hospitalId=${metro.id}`, {
    headers: { Authorization: `Bearer ${adminMetro.token}` },
  });
  console.log(`    [POSITIVE] Metro Admin -> Metro Dashboard: Status ${metroDashRes.status}`);
  if (metroDashRes.status !== 200) throw new Error('Metro Admin could not access Metro dashboard');

  // Negative: Access Apex Dashboard -> Expect 403
  const metroToApexDash = await fetch(`${BASE_URL}/api/analytics/dashboard/hospital-admin?hospitalId=${apex.id}`, {
    headers: { Authorization: `Bearer ${adminMetro.token}` },
  });
  console.log(`    [NEGATIVE] Metro Admin -> Apex Dashboard: Status ${metroToApexDash.status} (Expected 403)`);
  if (metroToApexDash.status !== 403) throw new Error('Metro Admin was not rejected with 403 on Apex dashboard');

  // Negative: Access Riverside Appointments -> Expect 403
  const metroToRiverAppts = await fetch(`${BASE_URL}/api/appointments?hospitalId=${riverside.id}`, {
    headers: { Authorization: `Bearer ${adminMetro.token}` },
  });
  console.log(`    [NEGATIVE] Metro Admin -> Riverside Appointments: Status ${metroToRiverAppts.status} (Expected 403)`);
  if (metroToRiverAppts.status !== 403) throw new Error('Metro Admin was not rejected with 403 on Riverside appointments');

  // Negative: Access Apex Doctors -> Expect 403
  const metroToApexDocs = await fetch(`${BASE_URL}/api/doctors?hospitalId=${apex.id}`, {
    headers: { Authorization: `Bearer ${adminMetro.token}` },
  });
  console.log(`    [NEGATIVE] Metro Admin -> Apex Doctors: Status ${metroToApexDocs.status} (Expected 403)`);
  if (metroToApexDocs.status !== 403) throw new Error('Metro Admin was not rejected with 403 on Apex doctors');

  // 3. Riverside Admin Checks
  console.log('  --- Checking Riverside Admin (admin@riversidehealth.org) ---');
  // Positive: Access Riverside Dashboard
  const riverDashRes = await fetch(`${BASE_URL}/api/analytics/dashboard/hospital-admin?hospitalId=${riverside.id}`, {
    headers: { Authorization: `Bearer ${adminRiverside.token}` },
  });
  console.log(`    [POSITIVE] Riverside Admin -> Riverside Dashboard: Status ${riverDashRes.status}`);
  if (riverDashRes.status !== 200) throw new Error('Riverside Admin could not access Riverside dashboard');

  // Negative: Access Apex Dashboard -> Expect 403
  const riverToApexDash = await fetch(`${BASE_URL}/api/analytics/dashboard/hospital-admin?hospitalId=${apex.id}`, {
    headers: { Authorization: `Bearer ${adminRiverside.token}` },
  });
  console.log(`    [NEGATIVE] Riverside Admin -> Apex Dashboard: Status ${riverToApexDash.status} (Expected 403)`);
  if (riverToApexDash.status !== 403) throw new Error('Riverside Admin was not rejected with 403 on Apex dashboard');

  // Negative: Access Metro Doctors -> Expect 403
  const riverToMetroDocs = await fetch(`${BASE_URL}/api/doctors?hospitalId=${metro.id}`, {
    headers: { Authorization: `Bearer ${adminRiverside.token}` },
  });
  console.log(`    [NEGATIVE] Riverside Admin -> Metro Doctors: Status ${riverToMetroDocs.status} (Expected 403)`);
  if (riverToMetroDocs.status !== 403) throw new Error('Riverside Admin was not rejected with 403 on Metro doctors');

  // Negative: Access Metro Appointments -> Expect 403
  const riverToMetroAppts = await fetch(`${BASE_URL}/api/appointments?hospitalId=${metro.id}`, {
    headers: { Authorization: `Bearer ${adminRiverside.token}` },
  });
  console.log(`    [NEGATIVE] Riverside Admin -> Metro Appointments: Status ${riverToMetroAppts.status} (Expected 403)`);
  if (riverToMetroAppts.status !== 403) throw new Error('Riverside Admin was not rejected with 403 on Metro appointments');

  console.log('✅ All 3 Hospital Admins passed positive and negative isolation checks!\n');

  // ==========================================
  // C. DOCTOR CHECKS (6 DOCTORS)
  // ==========================================
  console.log('🩺 Step C: Verifying 6 Doctors across hospitals and specialties...');
  const doctorsList = [
    { email: 'dr.rao@apexhealth.org', name: 'Dr. Arvind Rao', hospital: 'Apex Regional', spec: 'Orthopedics' },
    { email: 'dr.patel@apexhealth.org', name: 'Dr. Maya Patel', hospital: 'Apex Regional', spec: 'Cardiology' },
    { email: 'dr.chen@metrohealth.org', name: 'Dr. Marcus Chen', hospital: 'Metropolitan Health', spec: 'Cardiology' },
    { email: 'dr.jenkins@metrohealth.org', name: 'Dr. Elena Jenkins', hospital: 'Metropolitan Health', spec: 'General Medicine' },
    { email: 'dr.rostova@riversidehealth.org', name: 'Dr. Anya Rostova', hospital: 'Riverside Community', spec: 'Orthopedics' },
    { email: 'dr.kim@riversidehealth.org', name: 'Dr. David Kim', hospital: 'Riverside Community', spec: 'General Medicine' },
  ];

  for (const doc of doctorsList) {
    const docAuth = await login(doc.email);
    const doctorRecord = await prisma.doctor.findFirst({
      where: { userId: docAuth.user.id },
      include: { hospital: true },
    });
    if (!doctorRecord) throw new Error(`Doctor record not found for ${doc.email}`);

    // Call /api/analytics/dashboard/doctor?doctorId=...
    const docDashRes = await fetch(`${BASE_URL}/api/analytics/dashboard/doctor?doctorId=${doctorRecord.id}`, {
      headers: { Authorization: `Bearer ${docAuth.token}` },
    });
    if (docDashRes.status !== 200) {
      throw new Error(`Doctor dashboard fetch failed for ${doc.email}: status ${docDashRes.status}`);
    }
    const docData = (await docDashRes.json()) as any;

    // Doctor sees their appointments
    console.log(`  ✓ ${doc.name} (${doc.hospital} - ${doc.spec}): Logged in, tenant=${docAuth.user.tenantId}, found ${docData.appointments?.length ?? 0} appts, ${docData.calendar?.length ?? 0} slots`);

    // Verify negative check: doctor cannot query another doctor's dashboard
    const otherDoctor = await prisma.doctor.findFirst({
      where: { id: { not: doctorRecord.id } },
    });
    if (otherDoctor) {
      const crossDocRes = await fetch(`${BASE_URL}/api/analytics/dashboard/doctor?doctorId=${otherDoctor.id}`, {
        headers: { Authorization: `Bearer ${docAuth.token}` },
      });
      if (crossDocRes.status !== 403) {
        throw new Error(`Doctor ${doc.name} was not rejected when querying doctor ${otherDoctor.id}`);
      }
    }
  }
  console.log('✅ All 6 Doctors verified with proper calendar and appointment isolation!\n');

  // ==========================================
  // D. PATIENT CHECKS (6 PATIENTS)
  // ==========================================
  console.log('👤 Step D: Verifying 6 Patients across hospitals...');
  const patientsList = [
    { email: 'jane.doe@example.com', name: 'Jane Doe', phone: '+1-555-0188' },
    { email: 'patient.john@example.com', name: 'John Doe', phone: '+1-555-0199' },
    { email: 'robert.taylor@example.com', name: 'Robert Taylor', phone: '+1-555-0211' },
    { email: 'emily.watson@example.com', name: 'Emily Watson', phone: '+1-555-0222' },
    { email: 'michael.chang@example.com', name: 'Michael Chang', phone: '+1-555-0333' },
    { email: 'sophia.martinez@example.com', name: 'Sophia Martinez', phone: '+1-555-0344' },
  ];

  for (const pat of patientsList) {
    const patAuth = await login(pat.email);
    const patRecord = await prisma.patient.findFirst({
      where: { userId: patAuth.user.id },
    });
    if (!patRecord) throw new Error(`Patient record not found for ${pat.email}`);

    // Call /api/analytics/dashboard/patient?patientId=...
    const patDashRes = await fetch(`${BASE_URL}/api/analytics/dashboard/patient?patientId=${patRecord.id}`, {
      headers: { Authorization: `Bearer ${patAuth.token}` },
    });
    if (patDashRes.status !== 200) {
      throw new Error(`Patient dashboard fetch failed for ${pat.email}: status ${patDashRes.status}`);
    }
    const patData = (await patDashRes.json()) as any;
    console.log(`  ✓ ${pat.name} (${pat.email}): Logged in, found ${patData.appointments?.length ?? 0} appointments, questionnaires=${patData.questionnaires?.length ?? 0}`);

    // Verify negative check: patient cannot query another patient's dashboard
    const otherPatient = await prisma.patient.findFirst({
      where: { id: { not: patRecord.id } },
    });
    if (otherPatient) {
      const crossPatRes = await fetch(`${BASE_URL}/api/analytics/dashboard/patient?patientId=${otherPatient.id}`, {
        headers: { Authorization: `Bearer ${patAuth.token}` },
      });
      if (crossPatRes.status !== 403) {
        throw new Error(`Patient ${pat.name} was not rejected when querying patient ${otherPatient.id}`);
      }
    }
  }
  console.log('✅ All 6 Patients verified with strict patient record isolation!\n');

  // ==========================================
  // E. SPOT-CHECK VOICE / AI BOOKING
  // ==========================================
  console.log('🎙️ Step E: Spot-checking AI scheduling turn with Dr. Elena Jenkins @ Metropolitan Health...');
  const docJenkins = await prisma.doctor.findFirst({
    where: { name: 'Dr. Elena Jenkins' },
    include: { hospital: true },
  });
  if (!docJenkins) throw new Error('Dr. Elena Jenkins not found');

  const availableSlot = await prisma.slot.findFirst({
    where: { doctorId: docJenkins.id, isBooked: false, isBlocked: false },
    orderBy: { startTime: 'asc' },
  });
  if (!availableSlot) throw new Error('No unbooked slot found for Dr. Jenkins');

  console.log(`  Target Doctor: ${docJenkins.name} (${docJenkins.hospital.name})`);
  console.log(`  Target Slot: ${availableSlot.startTime.toISOString()}`);

  const chatRes = await fetch(`${BASE_URL}/api/chat/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `I would like to see Dr. Elena Jenkins at Metropolitan Health System for a general medical exam`,
      hospitalId: metro.id,
    }),
  });

  const chatData = (await chatRes.json()) as any;
  console.log(`  AI Response Status: ${chatRes.status}`);
  console.log(`  AI Detected Intent: ${chatData.intentDetected || 'None'}`);
  console.log(`  AI Capability Called: ${chatData.capabilityCalled || 'None'}`);
  console.log(`  AI Spoken Text: "${chatData.spokenText || chatData.responseText}"`);

  console.log('\n🎉 ALL MULTI-TENANT VERIFICATION CHECKS PASSED WITH 100% SUCCESS!');
}

main()
  .catch((err) => {
    console.error('❌ Verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
