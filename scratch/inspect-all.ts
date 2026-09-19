import { prisma } from '@health/db';

async function main() {
  const users = await prisma.user.findMany();
  console.log('--- USERS ---');
  for (const u of users) {
    console.log(`User: ${u.email} | Role: ${u.role} | ID: ${u.id}`);
  }

  const patients = await prisma.patient.findMany({ include: { user: true } });
  console.log('--- PATIENTS ---');
  for (const p of patients) {
    const apptCount = await prisma.appointment.count({ where: { patientId: p.id } });
    console.log(`Patient: ${p.name} | User: ${p.user?.email} | PatientID: ${p.id} | Appointments: ${apptCount}`);
  }

  const doctors = await prisma.doctor.findMany({ include: { hospital: true } });
  console.log('--- DOCTORS ---');
  for (const d of doctors) {
    const apptCount = await prisma.appointment.count({ where: { doctorId: d.id } });
    console.log(`Doctor: ${d.name} (${d.specialty}) at ${d.hospital.name} | Appointments: ${apptCount}`);
  }

  const hospitals = await prisma.hospital.findMany();
  console.log('--- HOSPITALS ---');
  for (const h of hospitals) {
    const apptCount = await prisma.appointment.count({ where: { hospitalId: h.id } });
    console.log(`Hospital: ${h.name} (${h.slug}) | Status: ${h.status} | Appointments: ${apptCount}`);
  }

  const conns = await prisma.healthcareSystemConnection.findMany();
  console.log('--- CONNECTIONS ---');
  for (const c of conns) {
    console.log(`Connection: ${c.systemType} | HospitalID: ${c.hospitalId} | Status: ${c.status} | ID: ${c.id}`);
  }
}

main().catch(console.error);
