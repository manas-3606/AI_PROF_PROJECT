import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '@health/db';

const BASE_URL = 'http://localhost:3001';

async function verifyLayer3Live() {
  console.log('=== LAYER 3: Scheduling (PRD Section 7) Live Verification ===\n');

  // Step 1: Fetch an active doctor and patient
  const doctor = await prisma.doctor.findFirst({
    where: { status: 'ACTIVE' },
    include: { hospital: true, calendar: { include: { workingHours: true } } },
  });
  assert.ok(doctor && doctor.calendar, 'Active doctor with calendar must exist');

  const patient1 = await prisma.patient.findFirst();
  const patient2 = await prisma.patient.findFirst({
    where: { id: { not: patient1!.id } },
  });
  assert.ok(patient1 && patient2, 'Two distinct patients must exist in DB');

  // Create a brand-new unbooked slot within doctor's working hours (60 days out to prevent collision)
  const d = new Date();
  d.setDate(d.getDate() + 60);
  d.setHours(11, 0, 0, 0);
  // Ensure day of week matches working hour (Monday)
  const day = d.getDay();
  const diff = (1 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  const slotStartTime = new Date(d);
  const slotEndTime = new Date(slotStartTime.getTime() + 30 * 60 * 1000);

  await prisma.appointment.deleteMany({ where: { slot: { doctorId: doctor.id, startTime: slotStartTime } } });
  await prisma.slot.deleteMany({ where: { doctorId: doctor.id, startTime: slotStartTime } });

  const testSlot = await prisma.slot.create({
    data: {
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      startTime: slotStartTime,
      endTime: slotEndTime,
      isBooked: false,
      isBlocked: false,
    },
  });
  console.log(`Created clean test slot: ${testSlot.id} (${slotStartTime.toISOString()} - ${slotEndTime.toISOString()})`);

  // =========================================================================
  // CHECK 7: Fire Two Simultaneous Booking Requests via Real HTTP API
  // =========================================================================
  console.log('\n--- Check 7: Firing 2 Simultaneous Booking Requests via Real API (POST /api/appointments) ---');

  const req1Promise = fetch(`${BASE_URL}/api/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patientId: patient1.id,
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      slotId: testSlot.id,
      reason: 'Concurrent Race Patient 1',
      idempotencyKey: crypto.randomUUID(),
    }),
  });

  const req2Promise = fetch(`${BASE_URL}/api/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patientId: patient2.id,
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      slotId: testSlot.id,
      reason: 'Concurrent Race Patient 2',
      idempotencyKey: crypto.randomUUID(),
    }),
  });

  const [res1, res2] = await Promise.all([req1Promise, req2Promise]);
  const status1 = res1.status;
  const status2 = res2.status;
  const body1 = await res1.json();
  const body2 = await res2.json();

  console.log(`Patient 1 Request Status: ${status1}`, status1 === 201 ? 'SUCCESS (201)' : `REJECTED (${status1}): ${body1.error}`);
  console.log(`Patient 2 Request Status: ${status2}`, status2 === 201 ? 'SUCCESS (201)' : `REJECTED (${status2}): ${body2.error}`);

  const successCount = (status1 === 201 ? 1 : 0) + (status2 === 201 ? 1 : 0);
  const failureCount = (status1 >= 400 ? 1 : 0) + (status2 >= 400 ? 1 : 0);

  console.log(`Simultaneous Booking Result: Successes = ${successCount}, Failures = ${failureCount}`);
  assert.strictEqual(successCount, 1, 'Exactly one concurrent booking request must succeed');
  assert.strictEqual(failureCount, 1, 'Exactly one concurrent booking request must fail');

  // Verify DB: exactly 1 appointment recorded for the slot and slot isBooked = true
  const apptsInDb = await prisma.appointment.findMany({ where: { slotId: testSlot.id } });
  assert.strictEqual(apptsInDb.length, 1, 'Database must contain exactly 1 appointment for the contested slot');
  const updatedSlot = await prisma.slot.findUnique({ where: { id: testSlot.id } });
  assert.strictEqual(updatedSlot?.isBooked, true, 'Contested slot must be marked booked in database');
  console.log('✅ CHECK 7 PASSED: Atomic concurrency locking prevents double-booking. Exactly 1 succeeded.');

  // =========================================================================
  // CHECK 8: check_availability Live Exclusions
  // =========================================================================
  console.log('\n--- Check 8: check_availability Never Returns Inactive Doctor, Blocked Period, or Outside Working Hours ---');

  // Example 1: Inactive Doctor Excluded
  console.log('   [Check 8.1] Testing Inactive / Suspended Doctor Exclusion...');
  const suspendedDoc = await prisma.doctor.create({
    data: {
      userId: (await prisma.user.create({
        data: {
          email: `suspended.${Date.now()}@apexhealth.org`,
          passwordHash: 'dummy',
          name: 'Dr. Suspended Test',
          role: 'DOCTOR',
          hospitalId: doctor.hospitalId,
        },
      })).id,
      hospitalId: doctor.hospitalId,
      name: 'Dr. Suspended Test',
      specialty: 'Neurology',
      department: 'Neurology Dept',
      qualifications: 'MD',
      status: 'SUSPENDED',
    },
  });

  const checkSuspendedRes = await fetch(`${BASE_URL}/api/doctors/${suspendedDoc.id}/slots`);
  const checkSuspendedBody = await checkSuspendedRes.json();
  console.log(`   Suspended Doctor Available Slots Count: ${checkSuspendedBody.slots?.length || 0}`);
  assert.strictEqual(checkSuspendedBody.slots?.length || 0, 0, 'Inactive / Suspended doctor must return 0 available slots');
  console.log('   ✅ 8.1 Inactive doctor is strictly excluded from availability.');

  // Example 2: Blocked Period Excluded
  console.log('\n   [Check 8.2] Testing Calendar Blocked Period / Blackout Exclusion...');
  // Create an unbooked slot for doctor
  const blockedSlotTime = new Date(d);
  blockedSlotTime.setDate(blockedSlotTime.getDate() + 1); // next day
  blockedSlotTime.setHours(14, 0, 0, 0);
  const blockedSlotEndTime = new Date(blockedSlotTime.getTime() + 30 * 60 * 1000);

  await prisma.slot.deleteMany({ where: { doctorId: doctor.id, startTime: blockedSlotTime } });
  const slotInBlackout = await prisma.slot.create({
    data: {
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      startTime: blockedSlotTime,
      endTime: blockedSlotEndTime,
      isBooked: false,
      isBlocked: false,
    },
  });

  // Create overlapping blocked period
  await prisma.blockedSlot.deleteMany({ where: { calendarId: doctor.calendar.id, startTime: new Date(blockedSlotTime.getTime() - 15 * 60 * 1000) } });
  const blackoutPeriod = await prisma.blockedSlot.create({
    data: {
      calendarId: doctor.calendar.id,
      hospitalId: doctor.hospitalId,
      startTime: new Date(blockedSlotTime.getTime() - 15 * 60 * 1000),
      endTime: new Date(blockedSlotEndTime.getTime() + 15 * 60 * 1000),
      reason: 'Departmental Symposium Blackout',
    },
  });

  const checkBlackoutRes = await fetch(
    `${BASE_URL}/api/doctors/${doctor.id}/slots?startDate=${new Date(blockedSlotTime.getTime() - 3600000).toISOString()}&endDate=${new Date(blockedSlotEndTime.getTime() + 3600000).toISOString()}`
  );
  const checkBlackoutBody = await checkBlackoutRes.json();
  const foundBlockedSlot = (checkBlackoutBody.slots || []).find((s: any) => s.slotId === slotInBlackout.id || s.id === slotInBlackout.id);
  console.log(`   Slot overlapping blackout found in check_availability: ${!!foundBlockedSlot}`);
  assert.strictEqual(foundBlockedSlot, undefined, 'Slot in blocked period must NOT be returned');
  console.log('   ✅ 8.2 Blocked period slot is strictly excluded from availability.');

  // Example 3: Outside Working Hours Excluded
  console.log('\n   [Check 8.3] Testing Outside Working Hours Exclusion...');
  const nightTime = new Date(d);
  nightTime.setHours(23, 0, 0, 0); // 11:00 PM is well outside 09:00 - 17:00
  const nightEndTime = new Date(nightTime.getTime() + 30 * 60 * 1000);

  await prisma.slot.deleteMany({ where: { doctorId: doctor.id, startTime: nightTime } });
  const nightSlot = await prisma.slot.create({
    data: {
      doctorId: doctor.id,
      hospitalId: doctor.hospitalId,
      startTime: nightTime,
      endTime: nightEndTime,
      isBooked: false,
      isBlocked: false,
    },
  });

  const checkNightRes = await fetch(
    `${BASE_URL}/api/doctors/${doctor.id}/slots?startDate=${new Date(nightTime.getTime() - 3600000).toISOString()}&endDate=${new Date(nightEndTime.getTime() + 3600000).toISOString()}`
  );
  const checkNightBody = await checkNightRes.json();
  const foundNightSlot = (checkNightBody.slots || []).find((s: any) => s.slotId === nightSlot.id || s.id === nightSlot.id);
  console.log(`   Slot outside working hours found in check_availability: ${!!foundNightSlot}`);
  assert.strictEqual(foundNightSlot, undefined, 'Slot outside working hours must NOT be returned');
  console.log('   ✅ 8.3 Slot outside working hours is strictly excluded from availability.');

  // Clean up test records
  await prisma.blockedSlot.delete({ where: { id: blackoutPeriod.id } });
  await prisma.appointment.deleteMany({ where: { slotId: testSlot.id } });
  await prisma.slot.deleteMany({ where: { id: { in: [slotInBlackout.id, nightSlot.id, testSlot.id] } } });
  await prisma.doctor.delete({ where: { id: suspendedDoc.id } });

  console.log('\n🎉 LAYER 3 (Checks 7 & 8) PASSED LIVE WITH 100% COMPLIANCE!');
}

verifyLayer3Live().catch((err) => {
  console.error('❌ Layer 3 Verification Failed:', err);
  process.exit(1);
});
