import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding...');

  // 1. Clear existing data
  await prisma.appointmentStateHistory.deleteMany();
  await prisma.capability.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.operationalEvent.deleteMany();
  await prisma.reconciliationRecord.deleteMany();
  await prisma.integrationVerification.deleteMany();
  await prisma.integrationOperation.deleteMany();
  await prisma.healthcareSystemConnection.deleteMany();
  await prisma.externalIdentifierMapping.deleteMany();
  await prisma.workflowExecution.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.questionnaireResponse.deleteMany();
  await prisma.questionnaireQuestion.deleteMany();
  await prisma.questionnaire.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.slot.deleteMany();
  await prisma.blockedSlot.deleteMany();
  await prisma.workingHour.deleteMany();
  await prisma.calendar.deleteMany();
  await prisma.doctor.deleteMany();
  await prisma.department.deleteMany();
  await prisma.specialty.deleteMany();
  await prisma.userPreference.deleteMany();
  await prisma.patient.deleteMany();
  await prisma.aiContext.deleteMany();
  await prisma.capabilityExecution.deleteMany();
  await prisma.aiEvaluation.deleteMany();
  await prisma.aiConversation.deleteMany();
  await prisma.user.deleteMany();
  await prisma.hospital.deleteMany();
  await prisma.platform.deleteMany();

  // 2. Platform record
  const platform = await prisma.platform.create({
    data: {
      name: 'AI.Prof Healthcare Platform',
      version: '2.0.0',
      status: 'ACTIVE',
    },
  });

  // 3. Specialties
  const ortho = await prisma.specialty.create({
    data: { name: 'Orthopedics', description: 'Bones, joints, ligaments, tendons, and muscles' },
  });
  const cardio = await prisma.specialty.create({
    data: { name: 'Cardiology', description: 'Heart and cardiovascular conditions' },
  });
  const genMed = await prisma.specialty.create({
    data: { name: 'General Medicine', description: 'Primary care and internal medicine' },
  });

  // 4. Hospital 1: Apex Regional Medical Center (Approved)
  const hospitalApex = await prisma.hospital.create({
    data: {
      name: 'Apex Regional Medical Center',
      slug: 'apex-regional',
      status: 'APPROVED',
      address: '742 Evergreen Terrace, Medical District',
      city: 'Metro City',
      operatingHours: 'Mon-Fri: 08:00 - 18:00, Sat: 09:00 - 14:00',
      contactEmail: 'contact@apexhealth.org',
      contactPhone: '+1-555-0100',
      specialtiesJson: JSON.stringify(['Orthopedics', 'Cardiology', 'General Medicine']),
    },
  });

  // Hospital 2: Metropolitan Health System (Approved)
  const hospitalMetro = await prisma.hospital.create({
    data: {
      name: 'Metropolitan Health System',
      slug: 'metropolitan-health',
      status: 'APPROVED',
      address: '1000 Central Ave, Suite 400',
      city: 'Metro City',
      operatingHours: 'Mon-Fri: 09:00 - 17:00',
      contactEmail: 'info@metrohealth.org',
      contactPhone: '+1-555-0200',
      specialtiesJson: JSON.stringify(['Cardiology', 'General Medicine']),
    },
  });

  // Departments for Apex
  const deptOrtho = await prisma.department.create({
    data: { hospitalId: hospitalApex.id, name: 'Orthopedic Surgery & Sports Medicine' },
  });
  const deptCardio = await prisma.department.create({
    data: { hospitalId: hospitalApex.id, name: 'Cardiovascular Institute' },
  });

  // Common password hash for demo accounts: "Password123!" & "password123"
  const passwordHash = await bcrypt.hash('Password123!', 10);

  // 5. Users & Roles
  // Platform Admin
  await prisma.user.create({
    data: {
      email: 'platform.admin@health.org',
      passwordHash,
      name: 'Platform Administrator',
      role: 'PLATFORM_ADMIN',
    },
  });

  await prisma.user.create({
    data: {
      email: 'admin@platform.health',
      passwordHash,
      name: 'Platform Administrator (Alt)',
      role: 'PLATFORM_ADMIN',
    },
  });

  // Hospital Admin (Apex)
  await prisma.user.create({
    data: {
      email: 'admin@apexhealth.org',
      passwordHash,
      name: 'Apex Hospital Admin',
      role: 'HOSPITAL_ADMIN',
      hospitalId: hospitalApex.id,
    },
  });

  // Doctor 1: Dr. Arvind Rao
  const doctorRaoUser = await prisma.user.create({
    data: {
      email: 'dr.rao@apexhealth.org',
      passwordHash,
      name: 'Dr. Arvind Rao',
      role: 'DOCTOR',
      hospitalId: hospitalApex.id,
    },
  });

  const doctorRao = await prisma.doctor.create({
    data: {
      userId: doctorRaoUser.id,
      hospitalId: hospitalApex.id,
      departmentId: deptOrtho.id,
      specialtyId: ortho.id,
      name: 'Dr. Arvind Rao',
      specialty: 'Orthopedics',
      department: 'Orthopedic Surgery & Sports Medicine',
      qualifications: 'MD, MS (Orthopedics), Board Certified',
      experienceYears: 14,
      languagesJson: JSON.stringify(['English', 'Hindi']),
      consultationTypesJson: JSON.stringify(['In-Person', 'Telehealth']),
      appointmentDurationMinutes: 30,
      status: 'ACTIVE',
      externalProviderId: 'EXT-DOC-RAO-01',
    },
  });

  // Doctor 2: Dr. Maya Patel
  const doctorPatelUser = await prisma.user.create({
    data: {
      email: 'dr.patel@apexhealth.org',
      passwordHash,
      name: 'Dr. Maya Patel',
      role: 'DOCTOR',
      hospitalId: hospitalApex.id,
    },
  });

  const doctorPatel = await prisma.doctor.create({
    data: {
      userId: doctorPatelUser.id,
      hospitalId: hospitalApex.id,
      departmentId: deptCardio.id,
      specialtyId: cardio.id,
      name: 'Dr. Maya Patel',
      specialty: 'Cardiology',
      department: 'Cardiovascular Institute',
      qualifications: 'MD, FACC, Interventional Cardiology',
      experienceYears: 9,
      languagesJson: JSON.stringify(['English', 'Spanish']),
      consultationTypesJson: JSON.stringify(['In-Person', 'Telehealth']),
      appointmentDurationMinutes: 45,
      status: 'ACTIVE',
      externalProviderId: 'EXT-DOC-PATEL-02',
    },
  });

  // Patient 1: Jane Doe (Demo Patient)
  const janeDoeUser = await prisma.user.create({
    data: {
      email: 'jane.doe@example.com',
      passwordHash,
      name: 'Jane Doe',
      role: 'PATIENT',
    },
  });

  const janePatient = await prisma.patient.create({
    data: {
      userId: janeDoeUser.id,
      name: 'Jane Doe',
      phone: '+1-555-0188',
      email: 'jane.doe@example.com',
      dateOfBirth: '1992-06-15',
      communicationPreference: 'sms',
      externalPatientId: 'EXT-PAT-DOE-01',
    },
  });

  await prisma.userPreference.create({
    data: {
      patientId: janePatient.id,
      communicationChannel: 'sms',
      preferredDaysJson: JSON.stringify(['Monday', 'Wednesday', 'Friday']),
      preferredTimeOfDay: 'morning',
    },
  });

  // Patient 2: John Doe
  const patientUser = await prisma.user.create({
    data: {
      email: 'patient.john@example.com',
      passwordHash,
      name: 'John Doe',
      role: 'PATIENT',
    },
  });

  const patient = await prisma.patient.create({
    data: {
      userId: patientUser.id,
      name: 'John Doe',
      phone: '+1-555-0199',
      email: 'patient.john@example.com',
      dateOfBirth: '1988-04-12',
      communicationPreference: 'sms',
      externalPatientId: 'EXT-PAT-DOE-99',
    },
  });

  await prisma.userPreference.create({
    data: {
      patientId: patient.id,
      communicationChannel: 'sms',
      preferredDaysJson: JSON.stringify(['Tuesday', 'Thursday', 'Friday']),
      preferredTimeOfDay: 'afternoon',
    },
  });

  // 6. Calendars & Working Hours
  const calRao = await prisma.calendar.create({
    data: {
      doctorId: doctorRao.id,
      hospitalId: hospitalApex.id,
      name: "Dr. Arvind Rao's Primary Schedule",
      isActive: true,
    },
  });

  for (let day = 1; day <= 5; day++) {
    await prisma.workingHour.create({
      data: {
        calendarId: calRao.id,
        dayOfWeek: day,
        startTime: '09:00',
        endTime: '17:00',
      },
    });
  }

  // 7. Seed Real Bookable Slots for Dr. Rao (Next 5 Days)
  const now = new Date();
  for (let d = 0; d < 5; d++) {
    const slotDate = new Date(now);
    slotDate.setDate(now.getDate() + d);
    // If weekend, skip
    if (slotDate.getDay() === 0 || slotDate.getDay() === 6) continue;

    // Slots at 09:00, 10:00, 11:00, 14:00, 15:00, 16:00
    const hours = [9, 10, 11, 14, 15, 16];
    for (const h of hours) {
      const slotStart = new Date(slotDate);
      slotStart.setHours(h, 0, 0, 0);
      const slotEnd = new Date(slotDate);
      slotEnd.setHours(h, 30, 0, 0);

      await prisma.slot.create({
        data: {
          doctorId: doctorRao.id,
          hospitalId: hospitalApex.id,
          startTime: slotStart,
          endTime: slotEnd,
          isBooked: false,
          isBlocked: false,
        },
      });
    }
  }

  // 8. Pre-Visit Questionnaire: "General Orthopedic & Musculoskeletal Pre-Visit Intake"
  const questionnaire = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalApex.id,
      title: 'General Orthopedic & Musculoskeletal Pre-Visit Intake',
      description: 'Pre-visit screening questionnaire to inform your doctor about your symptoms and mobility.',
      specialty: 'Orthopedics',
    },
  });

  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questionnaire.id,
        orderIndex: 1,
        text: 'Are you experiencing severe or sudden numbness, tingling, or weakness in your limb?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questionnaire.id,
        orderIndex: 2,
        text: 'Which specific joint or area is causing you discomfort?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Shoulder', 'Knee', 'Hip', 'Spine / Back', 'Ankle / Foot', 'Other']),
      },
      {
        questionnaireId: questionnaire.id,
        orderIndex: 3,
        text: 'How long have you experienced this discomfort or limitation?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Less than 1 week', '1 to 4 weeks', '1 to 3 months', 'More than 3 months']),
      },
      {
        questionnaireId: questionnaire.id,
        orderIndex: 4,
        text: 'On a scale of 1 to 10, what is your current pain or discomfort level?',
        type: 'numeric',
        required: true,
      },
      {
        questionnaireId: questionnaire.id,
        orderIndex: 5,
        text: 'Briefly describe what makes the pain worse or better (e.g. lifting, resting, walking):',
        type: 'short_text',
        required: false,
      },
    ],
  });

  // 9. Healthcare System Connection (Mock EHR)
  await prisma.healthcareSystemConnection.create({
    data: {
      hospitalId: hospitalApex.id,
      systemType: 'MOCK_EHR',
      baseUrl: 'http://localhost:4000',
      status: 'ACTIVE',
      configJson: JSON.stringify({
        vendor: 'Apex Clinical Health Connect',
        timeoutMs: 3000,
        enableVerification: true,
      }),
    },
  });

  // 10. External Identifier Mappings (Patient, Doctor, Appointment, Facility)
  await prisma.externalIdentifierMapping.create({
    data: {
      hospitalId: hospitalApex.id,
      tenantId: hospitalApex.id,
      entityType: 'FACILITY',
      internalId: hospitalApex.id,
      externalId: 'EXT-FAC-APEX-01',
    },
  });

  await prisma.externalIdentifierMapping.create({
    data: {
      hospitalId: hospitalApex.id,
      tenantId: hospitalApex.id,
      entityType: 'DOCTOR',
      internalId: doctorRao.id,
      externalId: 'EXT-DOC-RAO-01',
    },
  });

  await prisma.externalIdentifierMapping.create({
    data: {
      hospitalId: hospitalApex.id,
      tenantId: hospitalApex.id,
      entityType: 'PATIENT',
      internalId: patient.id,
      externalId: 'EXT-PAT-DOE-99',
    },
  });

  // 11. Workflows
  await prisma.workflow.create({
    data: {
      hospitalId: hospitalApex.id,
      type: 'PreVisitQuestionnaire',
      triggerEvent: 'APPOINTMENT_CONFIRMED',
      configJson: JSON.stringify({ delayMinutes: 0, sendNotification: true }),
    },
  });

  await prisma.workflow.create({
    data: {
      hospitalId: hospitalApex.id,
      type: 'AppointmentReminder',
      triggerEvent: 'APPOINTMENT_CONFIRMED',
      configJson: JSON.stringify({ remindHoursBefore: 24, channel: 'sms' }),
    },
  });

  // 12. Seed 17 Exact PRD Section 10 Capabilities
  const capabilities = [
    { name: 'search_hospitals', description: 'Search directory of verified partner hospitals', category: 'DISCOVERY', riskLevel: 'READ_ONLY' },
    { name: 'search_doctors', description: 'Search credentialed physicians by specialty or criteria', category: 'DISCOVERY', riskLevel: 'READ_ONLY' },
    { name: 'check_availability', description: 'Query real-time calendar availability for doctor slots', category: 'SCHEDULING', riskLevel: 'READ_ONLY' },
    { name: 'lookup_patient', description: 'Find existing patient records by phone or identity', category: 'INTEGRATION', riskLevel: 'LOW' },
    { name: 'get_appointment', description: 'Retrieve appointment details and current status', category: 'SCHEDULING', riskLevel: 'READ_ONLY' },
    { name: 'create_appointment', description: 'Book an appointment slot atomically', category: 'SCHEDULING', riskLevel: 'HIGH' },
    { name: 'reschedule_appointment', description: 'Reschedule an existing appointment to a new slot', category: 'SCHEDULING', riskLevel: 'HIGH' },
    { name: 'cancel_appointment', description: 'Cancel an appointment and release the calendar slot', category: 'SCHEDULING', riskLevel: 'HIGH' },
    { name: 'get_questionnaire', description: 'Retrieve pre-visit intake questions for a specialty', category: 'WORKFLOW', riskLevel: 'READ_ONLY' },
    { name: 'submit_questionnaire', description: 'Submit patient responses for pre-visit clinical review', category: 'WORKFLOW', riskLevel: 'LOW' },
    { name: 'send_notification', description: 'Dispatch patient notification via SMS, Email, or In-App', category: 'COMMUNICATION', riskLevel: 'LOW' },
    { name: 'start_workflow', description: 'Initiate background workflow execution', category: 'WORKFLOW', riskLevel: 'LOW' },
    { name: 'get_context', description: 'Retrieve active conversation memory snapshot', category: 'COMMUNICATION', riskLevel: 'READ_ONLY' },
    { name: 'update_preferences', description: 'Update patient communication and scheduling preferences', category: 'COMMUNICATION', riskLevel: 'LOW' },
    { name: 'verify_external_appointment', description: 'Verify appointment state with external healthcare system', category: 'INTEGRATION', riskLevel: 'READ_ONLY' },
    { name: 'synchronize_state', description: 'Synchronize appointment records with external EHR', category: 'INTEGRATION', riskLevel: 'HIGH' },
    { name: 'transfer_to_human', description: 'Escalate call or conversation to human staff', category: 'COMMUNICATION', riskLevel: 'HIGH' },
  ];

  for (const cap of capabilities) {
    await prisma.capability.create({
      data: {
        name: cap.name,
        description: cap.description,
        category: cap.category,
        riskLevel: cap.riskLevel,
        isAiCallable: true,
        schemaVersion: '1.0.0',
      },
    });
  }

  console.log('✅ Database seeded successfully!');
  console.log(`   - Platform: ${platform.name}`);
  console.log(`   - Hospital: ${hospitalApex.name} (${hospitalApex.id})`);
  console.log(`   - Doctor: ${doctorRao.name} (${doctorRao.id})`);
  console.log(`   - Patient: ${patient.name} (${patient.phone})`);
  console.log(`   - Admin: admin@platform.health / password123`);
  console.log(`   - Hospital Admin: admin@apexhealth.org / password123`);
  console.log(`   - Doctor: dr.rao@apexhealth.org / password123`);
  console.log(`   - Patient: patient.john@example.com / password123`);
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
