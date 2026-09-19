import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('=== CHECK 22: Live Idempotency Verification ===');
  
  // 1. Authenticate as Patient Jane Doe
  const loginRes = await fetch('http://localhost:3001/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jane.doe@example.com', password: 'Password123!' })
  });
  const { token, user } = await loginRes.json() as any;
  const patient = await prisma.patient.findUnique({ where: { userId: user.id } });
  if (!patient) throw new Error('Patient not found');

  // 2. Find an available slot
  const slot = await prisma.slot.findFirst({
    where: {
      isBooked: false,
      isBlocked: false,
      startTime: { gt: new Date() }
    },
    include: {
      doctor: true,
      hospital: true
    }
  });
  if (!slot) throw new Error('No available slot found');
  console.log(`Using slot ${slot.id} with Doctor ${slot.doctor.name} at ${slot.startTime.toISOString()}`);

  const fixedIdempotencyKey = `live-idem-test-${crypto.randomUUID()}`;
  const payload = {
    patientId: patient.id,
    doctorId: slot.doctorId,
    slotId: slot.id,
    hospitalId: slot.hospitalId,
    reason: 'Idempotency Live Check',
    idempotencyKey: fixedIdempotencyKey
  };

  // 3. First booking call
  console.log('Sending first booking request with key:', fixedIdempotencyKey);
  const res1 = await fetch('http://localhost:3001/api/appointments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const data1 = await res1.json() as any;
  console.log(`Call 1: HTTP Status ${res1.status}, Data:`, JSON.stringify(data1));

  // 4. Second booking call with identical idempotencyKey
  console.log('Sending second booking request with identical key...');
  const res2 = await fetch('http://localhost:3001/api/appointments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const data2 = await res2.json() as any;
  console.log(`Call 2: HTTP Status ${res2.status}, Data:`, JSON.stringify(data2));

  const id1 = data1.appointmentId;
  const id2 = data2.appointmentId;
  const isMatch = id1 === id2 && !!id1;
  console.log(`ID Match: ${isMatch} (${id1})`);

  // 5. Query DB to confirm exactly 1 record
  const count = await prisma.appointment.count({
    where: { idempotencyKey: fixedIdempotencyKey }
  });
  console.log(`Appointments in DB with this key: ${count} (expected: 1)`);

  if (isMatch && count === 1 && (res2.status === 200 || res2.status === 201)) {
    console.log('>>> CHECK 22 RESULT: PASS <<<');
  } else {
    console.log('>>> CHECK 22 RESULT: FAIL <<<');
  }
}

main().finally(() => prisma.$disconnect());
