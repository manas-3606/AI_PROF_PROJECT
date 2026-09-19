import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { CapabilityRegistry } from '@health/capabilities';
import { prisma } from '@health/db';

describe('SECTION 2 — Search & Data Integrity (PRD Requirements)', () => {
  let apexHospital: any;

  before(async () => {
    apexHospital = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
    assert.ok(apexHospital, 'Apex Hospital must exist');
  });

  it('search_hospitals: never returns duplicate hospital IDs across multiple queries', async () => {
    const testQueries = [
      {},
      { city: 'Metro' },
      { query: 'Regional' },
      { specialty: 'Orthopedics' },
      { specialty: 'Cardiology' },
      { query: 'Apex' },
    ];

    for (const q of testQueries) {
      const result = await CapabilityRegistry.execute('search_hospitals', q, {
        actorRole: 'PATIENT',
      });

      assert.ok(Array.isArray(result.hospitals), 'Expected array of hospitals');
      const ids = result.hospitals.map((h: any) => h.id);
      const uniqueIds = new Set(ids);

      assert.strictEqual(
        ids.length,
        uniqueIds.size,
        `Duplicate hospital IDs found in search_hospitals with query ${JSON.stringify(q)}: ${ids.join(', ')}`
      );
    }
  });

  it('search_doctors: never returns duplicate doctor IDs across multiple queries', async () => {
    const testQueries = [
      {},
      { specialty: 'Orthopedics' },
      { specialty: 'Cardiology' },
      { name: 'Rao' },
      { name: 'Patel' },
      { hospitalId: apexHospital.id },
      { language: 'English' },
      { hospitalId: apexHospital.id, specialty: 'Orthopedics' },
    ];

    for (const q of testQueries) {
      const result = await CapabilityRegistry.execute('search_doctors', q, {
        actorRole: 'PATIENT',
        tenantId: apexHospital.id,
      });

      assert.ok(Array.isArray(result.doctors), 'Expected array of doctors');
      const ids = result.doctors.map((d: any) => d.id);
      const uniqueIds = new Set(ids);

      assert.strictEqual(
        ids.length,
        uniqueIds.size,
        `Duplicate doctor IDs found in search_doctors with query ${JSON.stringify(q)}: ${ids.join(', ')}`
      );
    }
  });

  it('check_availability: never returns duplicate slot IDs', async () => {
    const doctor = await prisma.doctor.findFirst({ where: { hospitalId: apexHospital.id } });
    assert.ok(doctor);

    const now = new Date();
    const end = new Date(Date.now() + 14 * 24 * 3600 * 1000);

    const result = await CapabilityRegistry.execute(
      'check_availability',
      {
        doctorId: doctor.id,
        startDate: now.toISOString(),
        endDate: end.toISOString(),
      },
      { actorRole: 'PATIENT', tenantId: apexHospital.id }
    );

    const slotIds = (result.slots || []).map((s: any) => s.slotId);
    const uniqueSlotIds = new Set(slotIds);

    assert.strictEqual(
      slotIds.length,
      uniqueSlotIds.size,
      `Duplicate slot IDs found in check_availability: ${slotIds.join(', ')}`
    );
  });

  it('raw DB query validation: database contains zero duplicate doctor records for active rosters', async () => {
    const doctors = await prisma.doctor.findMany({
      where: { status: 'ACTIVE', hospitalId: apexHospital.id },
      include: { hospital: true },
    });

    const docNames = doctors.map((d) => d.name);
    const uniqueNames = new Set(docNames);

    console.log(`[RAW DB QUERY] Active Doctors for ${apexHospital.name}:`);
    for (const d of doctors) {
      console.log(` - Doctor: ${d.name} (ID: ${d.id}, Specialty: ${d.specialty}, ExternalId: ${d.externalProviderId})`);
    }

    assert.strictEqual(
      docNames.length,
      uniqueNames.size,
      `Found duplicate doctor names in active roster: ${docNames.join(', ')}`
    );
  });
});
