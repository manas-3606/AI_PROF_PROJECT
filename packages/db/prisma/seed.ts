import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting comprehensive multi-tenant database seeding...');

  // 1. Clear existing data in reverse dependency order
  await prisma.appointmentStateHistory.deleteMany();
  await prisma.capabilityExecution.deleteMany();
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
    data: { name: 'General Medicine', description: 'Primary care, prevention, and internal medicine' },
  });

  // 4. Hospitals (3 APPROVED Multi-Tenant Systems)
  // Hospital 1: Apex Regional Medical Center
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
      specialtiesJson: JSON.stringify(['Orthopedics', 'Cardiology']),
    },
  });

  // Hospital 2: Metropolitan Health System
  const hospitalMetro = await prisma.hospital.create({
    data: {
      name: 'Metropolitan Health System',
      slug: 'metropolitan-health',
      status: 'APPROVED',
      address: '1000 Central Ave, Suite 400',
      city: 'Metro City',
      operatingHours: 'Mon-Fri: 08:30 - 17:30',
      contactEmail: 'info@metrohealth.org',
      contactPhone: '+1-555-0200',
      specialtiesJson: JSON.stringify(['Cardiology', 'General Medicine']),
    },
  });

  // Hospital 3: Riverside Community Hospital
  const hospitalRiverside = await prisma.hospital.create({
    data: {
      name: 'Riverside Community Hospital',
      slug: 'riverside-community',
      status: 'APPROVED',
      address: '450 River Road, West Valley',
      city: 'Riverside',
      operatingHours: 'Mon-Fri: 08:00 - 17:00',
      contactEmail: 'care@riversidehealth.org',
      contactPhone: '+1-555-0300',
      specialtiesJson: JSON.stringify(['Orthopedics', 'General Medicine']),
    },
  });

  // Departments
  const deptApexOrtho = await prisma.department.create({
    data: { hospitalId: hospitalApex.id, name: 'Orthopedic Surgery & Sports Medicine' },
  });
  const deptApexCardio = await prisma.department.create({
    data: { hospitalId: hospitalApex.id, name: 'Cardiovascular Institute' },
  });

  const deptMetroCardio = await prisma.department.create({
    data: { hospitalId: hospitalMetro.id, name: 'Department of Cardiovascular Medicine' },
  });
  const deptMetroGenMed = await prisma.department.create({
    data: { hospitalId: hospitalMetro.id, name: 'Internal & General Medicine' },
  });

  const deptRiverOrtho = await prisma.department.create({
    data: { hospitalId: hospitalRiverside.id, name: 'Orthopedics & Joint Reconstruction' },
  });
  const deptRiverGenMed = await prisma.department.create({
    data: { hospitalId: hospitalRiverside.id, name: 'Family & Community Medicine' },
  });

  // Common password hash for ALL demo accounts: "Password123!"
  const passwordHash = await bcrypt.hash('Password123!', 10);

  // 5. Users & Roles
  // EXACTLY 1 Platform Admin
  const platformAdmin = await prisma.user.create({
    data: {
      email: 'platform.admin@health.org',
      passwordHash,
      name: 'Platform Administrator',
      role: 'PLATFORM_ADMIN',
    },
  });

  // Hospital Admins (1 per hospital, strictly unshared)
  const adminApex = await prisma.user.create({
    data: {
      email: 'admin@apexhealth.org',
      passwordHash,
      name: 'Apex Hospital Admin',
      role: 'HOSPITAL_ADMIN',
      hospitalId: hospitalApex.id,
    },
  });

  const adminMetro = await prisma.user.create({
    data: {
      email: 'admin@metrohealth.org',
      passwordHash,
      name: 'Metro Hospital Admin',
      role: 'HOSPITAL_ADMIN',
      hospitalId: hospitalMetro.id,
    },
  });

  const adminRiverside = await prisma.user.create({
    data: {
      email: 'admin@riversidehealth.org',
      passwordHash,
      name: 'Riverside Hospital Admin',
      role: 'HOSPITAL_ADMIN',
      hospitalId: hospitalRiverside.id,
    },
  });

  // 6 Doctors (spread across hospitals & specialties)
  // Doctor 1: Dr. Arvind Rao (Apex - Orthopedics)
  const userRao = await prisma.user.create({
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
      userId: userRao.id,
      hospitalId: hospitalApex.id,
      departmentId: deptApexOrtho.id,
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

  // Doctor 2: Dr. Maya Patel (Apex - Cardiology)
  const userPatel = await prisma.user.create({
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
      userId: userPatel.id,
      hospitalId: hospitalApex.id,
      departmentId: deptApexCardio.id,
      specialtyId: cardio.id,
      name: 'Dr. Maya Patel',
      specialty: 'Cardiology',
      department: 'Cardiovascular Institute',
      qualifications: 'MD, FACC, Interventional Cardiology',
      experienceYears: 11,
      languagesJson: JSON.stringify(['English', 'Spanish']),
      consultationTypesJson: JSON.stringify(['In-Person', 'Telehealth']),
      appointmentDurationMinutes: 30,
      status: 'ACTIVE',
      externalProviderId: 'EXT-DOC-PATEL-02',
    },
  });

  // Doctor 3: Dr. Marcus Chen (Metro - Cardiology)
  const userChen = await prisma.user.create({
    data: {
      email: 'dr.chen@metrohealth.org',
      passwordHash,
      name: 'Dr. Marcus Chen',
      role: 'DOCTOR',
      hospitalId: hospitalMetro.id,
    },
  });
  const doctorChen = await prisma.doctor.create({
    data: {
      userId: userChen.id,
      hospitalId: hospitalMetro.id,
      departmentId: deptMetroCardio.id,
      specialtyId: cardio.id,
      name: 'Dr. Marcus Chen',
      specialty: 'Cardiology',
      department: 'Department of Cardiovascular Medicine',
      qualifications: 'MD, FACC, Electrophysiology Specialist',
      experienceYears: 13,
      languagesJson: JSON.stringify(['English', 'Mandarin']),
      consultationTypesJson: JSON.stringify(['In-Person', 'Telehealth']),
      appointmentDurationMinutes: 30,
      status: 'ACTIVE',
      externalProviderId: 'EXT-DOC-CHEN-03',
    },
  });

  // Doctor 4: Dr. Elena Jenkins (Metro - General Medicine)
  const userJenkins = await prisma.user.create({
    data: {
      email: 'dr.jenkins@metrohealth.org',
      passwordHash,
      name: 'Dr. Elena Jenkins',
      role: 'DOCTOR',
      hospitalId: hospitalMetro.id,
    },
  });
  const doctorJenkins = await prisma.doctor.create({
    data: {
      userId: userJenkins.id,
      hospitalId: hospitalMetro.id,
      departmentId: deptMetroGenMed.id,
      specialtyId: genMed.id,
      name: 'Dr. Elena Jenkins',
      specialty: 'General Medicine',
      department: 'Internal & General Medicine',
      qualifications: 'MD, Board Certified Internal Medicine',
      experienceYears: 8,
      languagesJson: JSON.stringify(['English']),
      consultationTypesJson: JSON.stringify(['In-Person', 'Telehealth']),
      appointmentDurationMinutes: 30,
      status: 'ACTIVE',
      externalProviderId: 'EXT-DOC-JENKINS-04',
    },
  });

  // Doctor 5: Dr. Anya Rostova (Riverside - Orthopedics)
  const userRostova = await prisma.user.create({
    data: {
      email: 'dr.rostova@riversidehealth.org',
      passwordHash,
      name: 'Dr. Anya Rostova',
      role: 'DOCTOR',
      hospitalId: hospitalRiverside.id,
    },
  });
  const doctorRostova = await prisma.doctor.create({
    data: {
      userId: userRostova.id,
      hospitalId: hospitalRiverside.id,
      departmentId: deptRiverOrtho.id,
      specialtyId: ortho.id,
      name: 'Dr. Anya Rostova',
      specialty: 'Orthopedics',
      department: 'Orthopedics & Joint Reconstruction',
      qualifications: 'MD, Sports Medicine & Joint Reconstruction',
      experienceYears: 10,
      languagesJson: JSON.stringify(['English', 'Russian']),
      consultationTypesJson: JSON.stringify(['In-Person', 'Telehealth']),
      appointmentDurationMinutes: 30,
      status: 'ACTIVE',
      externalProviderId: 'EXT-DOC-ROSTOVA-05',
    },
  });

  // Doctor 6: Dr. David Kim (Riverside - General Medicine)
  const userKim = await prisma.user.create({
    data: {
      email: 'dr.kim@riversidehealth.org',
      passwordHash,
      name: 'Dr. David Kim',
      role: 'DOCTOR',
      hospitalId: hospitalRiverside.id,
    },
  });
  const doctorKim = await prisma.doctor.create({
    data: {
      userId: userKim.id,
      hospitalId: hospitalRiverside.id,
      departmentId: deptRiverGenMed.id,
      specialtyId: genMed.id,
      name: 'Dr. David Kim',
      specialty: 'General Medicine',
      department: 'Family & Community Medicine',
      qualifications: 'MD, Primary Care & Preventive Medicine',
      experienceYears: 12,
      languagesJson: JSON.stringify(['English', 'Korean']),
      consultationTypesJson: JSON.stringify(['In-Person', 'Telehealth']),
      appointmentDurationMinutes: 30,
      status: 'ACTIVE',
      externalProviderId: 'EXT-DOC-KIM-06',
    },
  });

  const allDoctors = [
    { doc: doctorRao, hosp: hospitalApex },
    { doc: doctorPatel, hosp: hospitalApex },
    { doc: doctorChen, hosp: hospitalMetro },
    { doc: doctorJenkins, hosp: hospitalMetro },
    { doc: doctorRostova, hosp: hospitalRiverside },
    { doc: doctorKim, hosp: hospitalRiverside },
  ];

  // 6. Calendars & Working Hours for ALL Doctors
  for (const item of allDoctors) {
    const cal = await prisma.calendar.create({
      data: {
        doctorId: item.doc.id,
        hospitalId: item.hosp.id,
        name: `${item.doc.name} Schedule`,
        isActive: true,
      },
    });

    for (let day = 1; day <= 5; day++) {
      await prisma.workingHour.create({
        data: {
          calendarId: cal.id,
          dayOfWeek: day,
          startTime: '09:00',
          endTime: '17:00',
        },
      });
    }
  }

  // 7. Generate active unbooked slots for ALL Doctors across next 21 days
  const now = new Date();
  const slotHours = [9, 10, 11, 14, 15, 16];
  for (let d = 1; d <= 21; d++) {
    const slotDate = new Date(now);
    slotDate.setDate(now.getDate() + d);
    if (slotDate.getDay() === 0 || slotDate.getDay() === 6) continue; // Skip weekends

    for (const h of slotHours) {
      const slotStart = new Date(slotDate);
      slotStart.setHours(h, 0, 0, 0);
      const slotEnd = new Date(slotDate);
      slotEnd.setHours(h, 30, 0, 0);

      for (const item of allDoctors) {
        await prisma.slot.create({
          data: {
            doctorId: item.doc.id,
            hospitalId: item.hosp.id,
            startTime: slotStart,
            endTime: slotEnd,
            isBooked: false,
            isBlocked: false,
          },
        });
      }
    }
  }

  // 8. Patients (6 Patients across all 3 health systems)
  // Patient 1: Jane Doe (Apex)
  const userJane = await prisma.user.create({
    data: {
      email: 'jane.doe@example.com',
      passwordHash,
      name: 'Jane Doe',
      role: 'PATIENT',
    },
  });
  const patientJane = await prisma.patient.create({
    data: {
      userId: userJane.id,
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
      patientId: patientJane.id,
      hospitalId: hospitalApex.id,
      communicationChannel: 'sms',
      preferredDaysJson: JSON.stringify(['Monday', 'Wednesday', 'Friday']),
      preferredTimeOfDay: 'morning',
    },
  });

  // Patient 2: John Doe (Apex)
  const userJohn = await prisma.user.create({
    data: {
      email: 'patient.john@example.com',
      passwordHash,
      name: 'John Doe',
      role: 'PATIENT',
    },
  });
  const patientJohn = await prisma.patient.create({
    data: {
      userId: userJohn.id,
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
      patientId: patientJohn.id,
      hospitalId: hospitalApex.id,
      communicationChannel: 'sms',
      preferredDaysJson: JSON.stringify(['Tuesday', 'Thursday']),
      preferredTimeOfDay: 'afternoon',
    },
  });

  // Patient 3: Robert Taylor (Metro)
  const userTaylor = await prisma.user.create({
    data: {
      email: 'robert.taylor@example.com',
      passwordHash,
      name: 'Robert Taylor',
      role: 'PATIENT',
    },
  });
  const patientTaylor = await prisma.patient.create({
    data: {
      userId: userTaylor.id,
      name: 'Robert Taylor',
      phone: '+1-555-0211',
      email: 'robert.taylor@example.com',
      dateOfBirth: '1975-09-23',
      communicationPreference: 'sms',
      externalPatientId: 'EXT-PAT-TAY-03',
    },
  });
  await prisma.userPreference.create({
    data: {
      patientId: patientTaylor.id,
      hospitalId: hospitalMetro.id,
      communicationChannel: 'sms',
      preferredDaysJson: JSON.stringify(['Wednesday', 'Thursday']),
      preferredTimeOfDay: 'morning',
    },
  });

  // Patient 4: Emily Watson (Metro)
  const userWatson = await prisma.user.create({
    data: {
      email: 'emily.watson@example.com',
      passwordHash,
      name: 'Emily Watson',
      role: 'PATIENT',
    },
  });
  const patientWatson = await prisma.patient.create({
    data: {
      userId: userWatson.id,
      name: 'Emily Watson',
      phone: '+1-555-0222',
      email: 'emily.watson@example.com',
      dateOfBirth: '1990-11-05',
      communicationPreference: 'email',
      externalPatientId: 'EXT-PAT-WAT-04',
    },
  });
  await prisma.userPreference.create({
    data: {
      patientId: patientWatson.id,
      hospitalId: hospitalMetro.id,
      communicationChannel: 'email',
      preferredDaysJson: JSON.stringify(['Monday', 'Friday']),
      preferredTimeOfDay: 'afternoon',
    },
  });

  // Patient 5: Michael Chang (Riverside)
  const userChang = await prisma.user.create({
    data: {
      email: 'michael.chang@example.com',
      passwordHash,
      name: 'Michael Chang',
      role: 'PATIENT',
    },
  });
  const patientChang = await prisma.patient.create({
    data: {
      userId: userChang.id,
      name: 'Michael Chang',
      phone: '+1-555-0333',
      email: 'michael.chang@example.com',
      dateOfBirth: '1984-03-18',
      communicationPreference: 'sms',
      externalPatientId: 'EXT-PAT-CHA-05',
    },
  });
  await prisma.userPreference.create({
    data: {
      patientId: patientChang.id,
      hospitalId: hospitalRiverside.id,
      communicationChannel: 'sms',
      preferredDaysJson: JSON.stringify(['Tuesday', 'Wednesday']),
      preferredTimeOfDay: 'afternoon',
    },
  });

  // Patient 6: Sophia Martinez (Riverside)
  const userMartinez = await prisma.user.create({
    data: {
      email: 'sophia.martinez@example.com',
      passwordHash,
      name: 'Sophia Martinez',
      role: 'PATIENT',
    },
  });
  const patientMartinez = await prisma.patient.create({
    data: {
      userId: userMartinez.id,
      name: 'Sophia Martinez',
      phone: '+1-555-0344',
      email: 'sophia.martinez@example.com',
      dateOfBirth: '1995-07-29',
      communicationPreference: 'in_app',
      externalPatientId: 'EXT-PAT-MAR-06',
    },
  });
  await prisma.userPreference.create({
    data: {
      patientId: patientMartinez.id,
      hospitalId: hospitalRiverside.id,
      communicationChannel: 'in_app',
      preferredDaysJson: JSON.stringify(['Thursday', 'Friday']),
      preferredTimeOfDay: 'morning',
    },
  });

  // 9. Pre-Visit Questionnaires
  // Apex Questionnaire: Orthopedics
  const questApex = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalApex.id,
      title: 'Apex Orthopedic & Musculoskeletal Pre-Visit Intake',
      description: 'Pre-visit screening questionnaire to inform your orthopedist about your symptoms and joint mobility.',
      specialty: 'Orthopedics',
    },
  });
  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questApex.id,
        orderIndex: 1,
        text: 'Are you experiencing severe or sudden numbness, tingling, or weakness in your limb?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questApex.id,
        orderIndex: 2,
        text: 'Which specific joint or area is causing you discomfort?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Shoulder', 'Knee', 'Hip', 'Spine / Back', 'Ankle / Foot', 'Other']),
      },
      {
        questionnaireId: questApex.id,
        orderIndex: 3,
        text: 'How long have you experienced this discomfort or limitation?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Less than 1 week', '1 to 4 weeks', '1 to 3 months', 'More than 3 months']),
      },
      {
        questionnaireId: questApex.id,
        orderIndex: 4,
        text: 'On a scale of 1 to 10, what is your current pain or discomfort level?',
        type: 'numeric',
        required: true,
      },
      {
        questionnaireId: questApex.id,
        orderIndex: 5,
        text: 'Briefly describe what makes the pain worse or better (e.g. lifting, resting, walking):',
        type: 'short_text',
        required: false,
      },
    ],
  });

  // Metro Questionnaire: Cardiology
  const questMetro = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalMetro.id,
      title: 'Metropolitan Cardiovascular Pre-Consultation Intake',
      description: 'Cardiac history and symptom screening for upcoming specialist appointment.',
      specialty: 'Cardiology',
    },
  });
  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questMetro.id,
        orderIndex: 1,
        text: 'Have you experienced chest pressure, shortness of breath, or palpitations recently?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questMetro.id,
        orderIndex: 2,
        text: 'Do you have a personal or family history of heart disease or hypertension?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Yes, personal history', 'Yes, family history', 'Both', 'Neither / Unknown']),
      },
      {
        questionnaireId: questMetro.id,
        orderIndex: 3,
        text: 'Are you currently taking any prescription heart or blood pressure medications?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questMetro.id,
        orderIndex: 4,
        text: 'List your current cardiovascular medications or dosages, if applicable:',
        type: 'short_text',
        required: false,
      },
    ],
  });

  // Riverside Questionnaire: General Medicine
  const questRiverside = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalRiverside.id,
      title: 'Riverside Comprehensive Primary Care Intake',
      description: 'General health history and lifestyle assessment prior to visit.',
      specialty: 'General Medicine',
    },
  });
  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questRiverside.id,
        orderIndex: 1,
        text: 'What is the primary reason for your visit today?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Annual Checkup', 'New Acute Symptom', 'Chronic Condition Management', 'Medication Refill']),
      },
      {
        questionnaireId: questRiverside.id,
        orderIndex: 2,
        text: 'Do you have any known drug or environmental allergies?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questRiverside.id,
        orderIndex: 3,
        text: 'Briefly list any known drug allergies or reactions:',
        type: 'short_text',
        required: false,
      },
      {
        questionnaireId: questRiverside.id,
        orderIndex: 4,
        text: 'On a scale of 1 to 10, how would you rate your general energy and wellness recently?',
        type: 'numeric',
        required: true,
      },
    ],
  });

  // Metro Questionnaire: General Medicine (for Dr. Elena Jenkins and primary care visits)
  const questMetroGenMed = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalMetro.id,
      title: 'Metropolitan General Medicine & Primary Care Pre-Visit Intake',
      description: 'Pre-visit symptom screening and general health assessment for primary care consultations.',
      specialty: 'General Medicine',
    },
  });
  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questMetroGenMed.id,
        orderIndex: 1,
        text: 'What is the primary symptom or health concern you would like to address today?',
        type: 'short_text',
        required: true,
      },
      {
        questionnaireId: questMetroGenMed.id,
        orderIndex: 2,
        text: 'How long have you been experiencing these symptoms?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['1 to 3 days', '4 to 7 days', '1 to 2 weeks', 'More than 2 weeks']),
      },
      {
        questionnaireId: questMetroGenMed.id,
        orderIndex: 3,
        text: 'Have you had a fever, chills, difficulty swallowing, or severe fatigue?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questMetroGenMed.id,
        orderIndex: 4,
        text: 'Are you currently taking any prescription medications or over-the-counter remedies?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questMetroGenMed.id,
        orderIndex: 5,
        text: 'On a scale of 1 to 10, what is your current discomfort level?',
        type: 'numeric',
        required: true,
      },
    ],
  });

  // Metro Questionnaire: Orthopedics
  const questMetroOrtho = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalMetro.id,
      title: 'Metropolitan Orthopedic & Joint Health Pre-Visit Intake',
      description: 'Pre-visit mobility and musculoskeletal assessment.',
      specialty: 'Orthopedics',
    },
  });
  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questMetroOrtho.id,
        orderIndex: 1,
        text: 'Which specific joint or musculoskeletal area is causing you discomfort?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Knee', 'Shoulder', 'Hip', 'Back / Spine', 'Other']),
      },
      {
        questionnaireId: questMetroOrtho.id,
        orderIndex: 2,
        text: 'On a scale of 1 to 10, what is your current pain level?',
        type: 'numeric',
        required: true,
      },
    ],
  });

  // Apex Questionnaire: General Medicine
  const questApexGenMed = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalApex.id,
      title: 'Apex Primary Care & General Medicine Intake',
      description: 'General health history and symptom screening for internal medicine consultations.',
      specialty: 'General Medicine',
    },
  });
  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questApexGenMed.id,
        orderIndex: 1,
        text: 'What is the primary symptom or health concern you would like to address today?',
        type: 'short_text',
        required: true,
      },
      {
        questionnaireId: questApexGenMed.id,
        orderIndex: 2,
        text: 'Have you had a fever, chills, or sudden worsening of symptoms?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questApexGenMed.id,
        orderIndex: 3,
        text: 'On a scale of 1 to 10, what is your current discomfort level?',
        type: 'numeric',
        required: true,
      },
    ],
  });

  // Apex Questionnaire: Cardiology
  const questApexCardio = await prisma.questionnaire.create({
    data: {
      hospitalId: hospitalApex.id,
      title: 'Apex Heart & Vascular Pre-Consultation Intake',
      description: 'Cardiac history and symptom screening for upcoming specialist appointment.',
      specialty: 'Cardiology',
    },
  });
  await prisma.questionnaireQuestion.createMany({
    data: [
      {
        questionnaireId: questApexCardio.id,
        orderIndex: 1,
        text: 'Have you experienced chest pressure, shortness of breath, or palpitations recently?',
        type: 'yes_no',
        required: true,
      },
      {
        questionnaireId: questApexCardio.id,
        orderIndex: 2,
        text: 'Do you have a personal or family history of heart disease or hypertension?',
        type: 'choice',
        required: true,
        optionsJson: JSON.stringify(['Yes, personal history', 'Yes, family history', 'Both', 'Neither / Unknown']),
      },
    ],
  });

  // 10. Seed Realistic Appointment History & Dashboard Data across Tenants
  // Upcoming Appointment 1: Jane Doe with Dr. Rao (Apex)
  const slotJane = await prisma.slot.findFirst({
    where: { doctorId: doctorRao.id, hospitalId: hospitalApex.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });
  if (slotJane) {
    await prisma.slot.update({ where: { id: slotJane.id }, data: { isBooked: true } });
    const apptJane = await prisma.appointment.create({
      data: {
        patientId: patientJane.id,
        doctorId: doctorRao.id,
        hospitalId: hospitalApex.id,
        slotId: slotJane.id,
        startTime: slotJane.startTime,
        endTime: slotJane.endTime,
        status: 'Confirmed',
        reason: 'Shoulder mobility limitation and joint discomfort after tennis injury',
        idempotencyKey: `SEED-APPT-JANE-RAO-${slotJane.id}`,
      },
    });
    await prisma.appointmentStateHistory.create({
      data: {
        appointmentId: apptJane.id,
        hospitalId: hospitalApex.id,
        fromStatus: 'Requested',
        toStatus: 'Confirmed',
        reason: 'Slot reserved and auto-confirmed via AI scheduling conversation',
        actorRole: 'PATIENT',
        actorId: userJane.id,
      },
    });
    // Jane Doe Pre-visit Questionnaire Response
    await prisma.questionnaireResponse.create({
      data: {
        questionnaireId: questApex.id,
        patientId: patientJane.id,
        appointmentId: apptJane.id,
        hospitalId: hospitalApex.id,
        answersJson: JSON.stringify({
          q1: 'No',
          q2: 'Shoulder',
          q3: '1 to 4 weeks',
          q4: '4',
          q5: 'Discomfort when lifting arm overhead; relieved by ice packs and resting',
        }),
        flaggedUrgent: false,
      },
    });
  }

  // Past Completed Appointment 2: John Doe with Dr. Patel (Apex)
  const pastDatePatel = new Date(now);
  pastDatePatel.setDate(now.getDate() - 5);
  pastDatePatel.setHours(14, 0, 0, 0);
  const pastEndDatePatel = new Date(pastDatePatel);
  pastEndDatePatel.setMinutes(30);

  const pastSlotPatel = await prisma.slot.create({
    data: {
      doctorId: doctorPatel.id,
      hospitalId: hospitalApex.id,
      startTime: pastDatePatel,
      endTime: pastEndDatePatel,
      isBooked: true,
      isBlocked: false,
    },
  });
  const apptJohn = await prisma.appointment.create({
    data: {
      patientId: patientJohn.id,
      doctorId: doctorPatel.id,
      hospitalId: hospitalApex.id,
      slotId: pastSlotPatel.id,
      startTime: pastDatePatel,
      endTime: pastEndDatePatel,
      status: 'Completed',
      reason: 'Routine cardiovascular follow-up and resting ECG assessment',
      idempotencyKey: `SEED-APPT-JOHN-PATEL-${pastSlotPatel.id}`,
    },
  });
  await prisma.appointmentStateHistory.create({
    data: {
      appointmentId: apptJohn.id,
      hospitalId: hospitalApex.id,
      fromStatus: 'Confirmed',
      toStatus: 'Completed',
      reason: 'Consultation completed successfully; vitals and ECG normal',
      actorRole: 'DOCTOR',
      actorId: userPatel.id,
    },
  });

  // Upcoming Appointment 3: Robert Taylor with Dr. Chen (Metro)
  const slotTaylor = await prisma.slot.findFirst({
    where: { doctorId: doctorChen.id, hospitalId: hospitalMetro.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });
  if (slotTaylor) {
    await prisma.slot.update({ where: { id: slotTaylor.id }, data: { isBooked: true } });
    const apptTaylor = await prisma.appointment.create({
      data: {
        patientId: patientTaylor.id,
        doctorId: doctorChen.id,
        hospitalId: hospitalMetro.id,
        slotId: slotTaylor.id,
        startTime: slotTaylor.startTime,
        endTime: slotTaylor.endTime,
        status: 'Confirmed',
        reason: 'Evaluation of occasional palpitations and exercise tolerance check',
        idempotencyKey: `SEED-APPT-TAYLOR-CHEN-${slotTaylor.id}`,
      },
    });
    await prisma.appointmentStateHistory.create({
      data: {
        appointmentId: apptTaylor.id,
        hospitalId: hospitalMetro.id,
        fromStatus: 'Requested',
        toStatus: 'Confirmed',
        reason: 'Confirmed directly through patient portal booking',
        actorRole: 'PATIENT',
        actorId: userTaylor.id,
      },
    });
  }

  // Past Completed Appointment 4: Emily Watson with Dr. Jenkins (Metro)
  const pastDateJenkins = new Date(now);
  pastDateJenkins.setDate(now.getDate() - 7);
  pastDateJenkins.setHours(10, 0, 0, 0);
  const pastEndDateJenkins = new Date(pastDateJenkins);
  pastEndDateJenkins.setMinutes(30);

  const pastSlotJenkins = await prisma.slot.create({
    data: {
      doctorId: doctorJenkins.id,
      hospitalId: hospitalMetro.id,
      startTime: pastDateJenkins,
      endTime: pastEndDateJenkins,
      isBooked: true,
      isBlocked: false,
    },
  });
  const apptWatson = await prisma.appointment.create({
    data: {
      patientId: patientWatson.id,
      doctorId: doctorJenkins.id,
      hospitalId: hospitalMetro.id,
      slotId: pastSlotJenkins.id,
      startTime: pastDateJenkins,
      endTime: pastEndDateJenkins,
      status: 'Completed',
      reason: 'Annual preventive wellness checkup and routine blood chemistry',
      idempotencyKey: `SEED-APPT-WATSON-JENKINS-${pastSlotJenkins.id}`,
    },
  });
  await prisma.appointmentStateHistory.create({
    data: {
      appointmentId: apptWatson.id,
      hospitalId: hospitalMetro.id,
      fromStatus: 'Confirmed',
      toStatus: 'Completed',
      reason: 'Wellness exam completed; routine labs ordered',
      actorRole: 'DOCTOR',
      actorId: userJenkins.id,
    },
  });

  // Upcoming Appointment 5: Michael Chang with Dr. Rostova (Riverside)
  const slotChang = await prisma.slot.findFirst({
    where: { doctorId: doctorRostova.id, hospitalId: hospitalRiverside.id, isBooked: false },
    orderBy: { startTime: 'asc' },
  });
  if (slotChang) {
    await prisma.slot.update({ where: { id: slotChang.id }, data: { isBooked: true } });
    const apptChang = await prisma.appointment.create({
      data: {
        patientId: patientChang.id,
        doctorId: doctorRostova.id,
        hospitalId: hospitalRiverside.id,
        slotId: slotChang.id,
        startTime: slotChang.startTime,
        endTime: slotChang.endTime,
        status: 'Confirmed',
        reason: 'Right knee meniscus follow-up and physical therapy progress review',
        idempotencyKey: `SEED-APPT-CHANG-ROSTOVA-${slotChang.id}`,
      },
    });
    await prisma.appointmentStateHistory.create({
      data: {
        appointmentId: apptChang.id,
        hospitalId: hospitalRiverside.id,
        fromStatus: 'Requested',
        toStatus: 'Confirmed',
        reason: 'Appointment confirmed with Dr. Rostova clinic staff',
        actorRole: 'PATIENT',
        actorId: userChang.id,
      },
    });
  }

  // Past Completed Appointment 6: Sophia Martinez with Dr. Kim (Riverside)
  const pastDateKim = new Date(now);
  pastDateKim.setDate(now.getDate() - 4);
  pastDateKim.setHours(9, 0, 0, 0);
  const pastEndDateKim = new Date(pastDateKim);
  pastEndDateKim.setMinutes(30);

  const pastSlotKim = await prisma.slot.create({
    data: {
      doctorId: doctorKim.id,
      hospitalId: hospitalRiverside.id,
      startTime: pastDateKim,
      endTime: pastEndDateKim,
      isBooked: true,
      isBlocked: false,
    },
  });
  const apptMartinez = await prisma.appointment.create({
    data: {
      patientId: patientMartinez.id,
      doctorId: doctorKim.id,
      hospitalId: hospitalRiverside.id,
      slotId: pastSlotKim.id,
      startTime: pastDateKim,
      endTime: pastEndDateKim,
      status: 'Completed',
      reason: 'Seasonal allergy consultation and inhaler medication renewal',
      idempotencyKey: `SEED-APPT-MARTINEZ-KIM-${pastSlotKim.id}`,
    },
  });
  await prisma.appointmentStateHistory.create({
    data: {
      appointmentId: apptMartinez.id,
      hospitalId: hospitalRiverside.id,
      fromStatus: 'Confirmed',
      toStatus: 'Completed',
      reason: 'Consultation completed; prescription renewed',
      actorRole: 'DOCTOR',
      actorId: userKim.id,
    },
  });

  // 11. Healthcare System Connections (Mock EHR)
  const hospitals = [
    { hosp: hospitalApex, vendor: 'Apex Clinical Health Connect', port: 4000 },
    { hosp: hospitalMetro, vendor: 'Metro CareLink Integration Engine', port: 4001 },
    { hosp: hospitalRiverside, vendor: 'Riverside Community EHR Gateway', port: 4002 },
  ];

  for (const h of hospitals) {
    const ehrBaseUrl = process.env.MOCK_EHR_URL || `http://localhost:${h.port}`;
    await prisma.healthcareSystemConnection.create({
      data: {
        hospitalId: h.hosp.id,
        systemType: 'MOCK_EHR',
        baseUrl: ehrBaseUrl,
        status: 'ACTIVE',
        configJson: JSON.stringify({
          vendor: h.vendor,
          timeoutMs: 3000,
          enableVerification: true,
        }),
      },
    });

    // Facility External Mapping
    await prisma.externalIdentifierMapping.create({
      data: {
        hospitalId: h.hosp.id,
        tenantId: h.hosp.id,
        entityType: 'FACILITY',
        internalId: h.hosp.id,
        externalId: `EXT-FAC-${h.hosp.slug.toUpperCase()}`,
      },
    });

    // Workflows for each hospital
    await prisma.workflow.create({
      data: {
        hospitalId: h.hosp.id,
        type: 'PreVisitQuestionnaire',
        triggerEvent: 'APPOINTMENT_CONFIRMED',
        configJson: JSON.stringify({ delayMinutes: 0, sendNotification: true }),
      },
    });
    await prisma.workflow.create({
      data: {
        hospitalId: h.hosp.id,
        type: 'AppointmentReminder',
        triggerEvent: 'APPOINTMENT_CONFIRMED',
        configJson: JSON.stringify({ remindHoursBefore: 24, channel: 'sms' }),
      },
    });
  }

  // Doctor & Patient External Mappings
  await prisma.externalIdentifierMapping.createMany({
    data: [
      { hospitalId: hospitalApex.id, tenantId: hospitalApex.id, entityType: 'DOCTOR', internalId: doctorRao.id, externalId: 'EXT-DOC-RAO-01' },
      { hospitalId: hospitalApex.id, tenantId: hospitalApex.id, entityType: 'DOCTOR', internalId: doctorPatel.id, externalId: 'EXT-DOC-PATEL-02' },
      { hospitalId: hospitalMetro.id, tenantId: hospitalMetro.id, entityType: 'DOCTOR', internalId: doctorChen.id, externalId: 'EXT-DOC-CHEN-03' },
      { hospitalId: hospitalMetro.id, tenantId: hospitalMetro.id, entityType: 'DOCTOR', internalId: doctorJenkins.id, externalId: 'EXT-DOC-JENKINS-04' },
      { hospitalId: hospitalRiverside.id, tenantId: hospitalRiverside.id, entityType: 'DOCTOR', internalId: doctorRostova.id, externalId: 'EXT-DOC-ROSTOVA-05' },
      { hospitalId: hospitalRiverside.id, tenantId: hospitalRiverside.id, entityType: 'DOCTOR', internalId: doctorKim.id, externalId: 'EXT-DOC-KIM-06' },
      { hospitalId: hospitalApex.id, tenantId: hospitalApex.id, entityType: 'PATIENT', internalId: patientJane.id, externalId: 'EXT-PAT-DOE-01' },
      { hospitalId: hospitalApex.id, tenantId: hospitalApex.id, entityType: 'PATIENT', internalId: patientJohn.id, externalId: 'EXT-PAT-DOE-99' },
    ],
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

  console.log('✅ Multi-tenant database seeded successfully!');
  console.log(`   - Platform: ${platform.name}`);
  console.log(`   - Platform Admin: ${platformAdmin.email} (Password123!)`);
  console.log(`   - Hospitals:`);
  console.log(`     • ${hospitalApex.name} (Admin: ${adminApex.email})`);
  console.log(`     • ${hospitalMetro.name} (Admin: ${adminMetro.email})`);
  console.log(`     • ${hospitalRiverside.name} (Admin: ${adminRiverside.email})`);
  console.log(`   - Doctors (6 active with schedules and bookable slots):`);
  console.log(`     • Dr. Arvind Rao (${doctorRao.specialty} @ ${hospitalApex.name}) - ${userRao.email}`);
  console.log(`     • Dr. Maya Patel (${doctorPatel.specialty} @ ${hospitalApex.name}) - ${userPatel.email}`);
  console.log(`     • Dr. Marcus Chen (${doctorChen.specialty} @ ${hospitalMetro.name}) - ${userChen.email}`);
  console.log(`     • Dr. Elena Jenkins (${doctorJenkins.specialty} @ ${hospitalMetro.name}) - ${userJenkins.email}`);
  console.log(`     • Dr. Anya Rostova (${doctorRostova.specialty} @ ${hospitalRiverside.name}) - ${userRostova.email}`);
  console.log(`     • Dr. David Kim (${doctorKim.specialty} @ ${hospitalRiverside.name}) - ${userKim.email}`);
  console.log(`   - Patients (6 realistic profiles across systems):`);
  console.log(`     • Jane Doe (${patientJane.phone}) - ${userJane.email}`);
  console.log(`     • John Doe (${patientJohn.phone}) - ${userJohn.email}`);
  console.log(`     • Robert Taylor (${patientTaylor.phone}) - ${userTaylor.email}`);
  console.log(`     • Emily Watson (${patientWatson.phone}) - ${userWatson.email}`);
  console.log(`     • Michael Chang (${patientChang.phone}) - ${userChang.email}`);
  console.log(`     • Sophia Martinez (${patientMartinez.phone}) - ${userMartinez.email}`);
  console.log(`   - Global Demo Password for all accounts: Password123!`);
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
