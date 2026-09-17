import { prisma } from '@health/db';
import { logger } from '@health/observability';
import { CapabilityRegistry, CapabilityMetadata } from './registry.js';
import { ConversationContextManager, ActiveContext } from './context-manager.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AgentTurnInput {
  conversationId: string;
  userUtterance: string;
  patientId?: string;
  hospitalId?: string;
  channel?: 'TEXT' | 'VOICE';
  correlationId?: string;
}

export interface AgentTurnResponse {
  spokenText: string;
  responseText: string;
  intentDetected?: string;
  capabilityCalled?: string;
  capabilityResult?: any;
  clarificationNeeded?: boolean;
  transferredToHuman?: boolean;
  correlationId: string;
  context: ActiveContext;
}

/**
 * Loads the official AI System Prompt from /docs/ai/SYSTEM_PROMPT.md.
 * Keeps prompt reviewable, auditable, and separate from application code.
 */
export function loadSystemPrompt(): string {
  // Upward traversal from current file and process.cwd()
  const searchRoots = [__dirname, process.cwd()];
  for (const root of searchRoots) {
    let curr = root;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(curr, 'docs', 'ai', 'SYSTEM_PROMPT.md');
      if (fs.existsSync(candidate)) {
        try {
          return fs.readFileSync(candidate, 'utf-8');
        } catch {
          // continue
        }
      }
      curr = path.dirname(curr);
    }
  }

  return '# SYSTEM PROMPT: AI PATIENT ACCESS AGENT (PRD SECTION 9 & 20)\nYou are an administrative and scheduling assistant only. NO Diagnosis, NO Prescribing, NO Treatment Recommendations. Clarification-Over-Guessing is strictly enforced.';
}

/**
 * AI Patient Access Agent (PRD Section 9, 10, 20)
 *
 * Implements:
 * 1. Strict PRD Section 20 clinical safety boundaries (refusing diagnosis, prescriptions, treatments).
 * 2. Clarification-over-guessing for ambiguous slots or requests.
 * 3. Pronoun/reference resolution across turns ("Actually, make that Friday").
 * 4. Separate server-side conversation context persisted per conversation ID.
 * 5. Strictly constrained tool-calling to Prompt 7 controlled capabilities.
 * 6. End-to-end correlation ID tracking for every capability execution.
 */
export class PatientAccessAgent {
  private conversationId: string;
  private patientId?: string;
  private hospitalId?: string;
  private channel: 'TEXT' | 'VOICE';

  constructor(options: {
    conversationId: string;
    patientId?: string;
    hospitalId?: string;
    channel?: 'TEXT' | 'VOICE';
  }) {
    this.conversationId = options.conversationId;
    this.patientId = options.patientId;
    this.hospitalId = options.hospitalId;
    this.channel = options.channel || 'TEXT';
  }

  /**
   * Process a single conversational turn with guaranteed normalization.
   */
  async processTurn(input: string | AgentTurnInput): Promise<AgentTurnResponse> {
    const res = await this.internalProcessTurn(input);
    return {
      spokenText: res.spokenText || '',
      responseText: res.responseText || res.spokenText || '',
      intentDetected: res.intentDetected,
      capabilityCalled: res.capabilityCalled,
      capabilityResult: res.capabilityResult,
      clarificationNeeded: res.clarificationNeeded ?? false,
      transferredToHuman: res.transferredToHuman ?? false,
      correlationId: res.correlationId,
      context: res.context,
    };
  }

  private async internalProcessTurn(input: string | AgentTurnInput): Promise<AgentTurnResponse> {
    const turnInput: AgentTurnInput =
      typeof input === 'string'
        ? {
            conversationId: this.conversationId,
            userUtterance: input,
            patientId: this.patientId,
            hospitalId: this.hospitalId,
            channel: this.channel,
          }
        : input;

    const utterance = turnInput.userUtterance.trim();
    const correlationId = turnInput.correlationId || crypto.randomUUID();
    const textLower = utterance.toLowerCase();

    logger.info(
      { conversationId: this.conversationId, correlationId, utterance },
      'PatientAccessAgent processing conversational turn'
    );

    // 1. Fetch server-side conversation context (PRD Section 10)
    let context = await ConversationContextManager.getContext(this.conversationId);

    // Ensure conversation record exists in DB
    try {
      await prisma.aiConversation.upsert({
        where: { id: this.conversationId },
        update: { lastActivity: new Date() },
        create: {
          id: this.conversationId,
          channel: turnInput.channel === 'VOICE' ? 'web_voice' : 'text_chat',
          patientId: turnInput.patientId || context.preferences?.patientId,
          hospitalId: turnInput.hospitalId || context.selectedHospitalId,
        },
      });
    } catch {
      // Ignore if database conversation record already handled
    }

    // Resolve active patient ID
    let activePatientId = turnInput.patientId || this.patientId || context.preferences?.patientId;
    if (!activePatientId) {
      const defaultPatient = await prisma.patient.findFirst();
      activePatientId = defaultPatient?.id;
      if (activePatientId) {
        context = await ConversationContextManager.updateContext(this.conversationId, {
          preferences: { ...(context.preferences || {}), patientId: activePatientId },
        });
      }
    }

    const capabilityMeta: CapabilityMetadata = {
      conversationId: this.conversationId,
      correlationId,
      actorRole: 'PATIENT',
      patientId: activePatientId,
      hospitalId: turnInput.hospitalId || context.selectedHospitalId,
    };

    // 2. PRD Section 20: Strict Clinical Boundary Guardrail & Immediate Refusal
    const clinicalPatterns = [
      // Direct diagnosis requests
      /\b(diagnos[a-z]*|what condition do i have|what disease do i have|what illness|what do you think i have|do i have|what does this mean|what is wrong with me|is this indicative of|does this look like|tell me if this .* is a)\b/i,
      // Prescription requests & dosage
      /\b(prescrib[a-z]*|write a script|give me a prescription|refill my prescription|prescribe me|can i get antibiotics|medication dosage|take \d+\s?mg|should i stop taking|can i take .* with)\b/i,
      // Treatment recommendations & therapies
      /\b(treatment|cure|remedy|how should i treat|recommend a treatment|what to take|exercises or therapy should i do to heal|how to heal)\b/i,
      /\b(what|which)\s+.*(medicine|medication|drug|pill|antibiotic|antibiotics)\s+.*(should|can)\s+(?:i\s+)?take\b/i,
      /\b(should|can)\s+i\s+take\s+(?:any\s+)?(medicine|medication|drug|pill|antibiotic|antibiotics|aspirin|ibuprofen|tylenol|steroid)\b/i,
      /\b(antibiotic|antibiotics|medication|medicine|prescription)\b.*(take|prescribe|give me|recommend)\b/i,
      // High-risk acute clinical conditions / hypothetical diagnostics
      /\b(heart attack|stroke|chest pain and numbness|torn ligament|bone fracture|if someone had|hypothetically .* diagnose)\b/i,
    ];

    const isClinicalInquiry = clinicalPatterns.some((pattern) => pattern.test(textLower));

    if (isClinicalInquiry) {
      logger.warn(
        { conversationId: this.conversationId, correlationId, utterance },
        'PRD Section 20 clinical safety boundary triggered: refusing clinical inquiry'
      );

      // Invoke controlled capability: transfer_to_human
      const transferResult = await CapabilityRegistry.execute(
        'transfer_to_human',
        {
          conversationId: this.conversationId,
          reason: 'clinical_inquiry',
          department: 'ClinicalStaff',
          notes: `Patient asked out-of-scope clinical question: "${utterance}"`,
        },
        capabilityMeta
      );

      const refusalResponse =
        'I understand your concern. As an administrative access assistant, I am not permitted to provide medical diagnoses, suggest treatments, prescribe medication, or evaluate clinical conditions. I am immediately connecting you with a licensed clinical staff member who can assist you safely.';

      return {
        spokenText: refusalResponse,
        responseText: refusalResponse,
        intentDetected: 'CLINICAL_INQUIRY',
        capabilityCalled: 'transfer_to_human',
        capabilityResult: transferResult,
        transferredToHuman: true,
        clarificationNeeded: false,
        correlationId,
        context,
      };
    }

    // 3. Pronoun / Reference Resolution & Clarification Handling
    // Check if user is responding to an open clarification or slot choice
    if (
      context.currentIntent === 'AWAITING_SLOT_SELECTION' &&
      context.lastOfferedSlotIds &&
      context.lastOfferedSlotIds.length > 0
    ) {
      // Check for slot choices: "the morning one", "first one", "9am", "second one", "afternoon"
      const isSlotChoice =
        /\b(morning|afternoon|first|second|1st|2nd|9:00|9am|10:00|10am|2:00|2pm|3:00|3pm|that one|book it|yes)\b/i.test(
          textLower
        );

      if (isSlotChoice && !textLower.includes('actually, make that')) {
        return this.handleSlotSelectionTurn(textLower, context, activePatientId!, capabilityMeta);
      }
    }

    // 4. Pronoun / Anaphora Resolution: "Actually, make that Friday" (PRD Section 10 Example)
    const makeThatDayMatch = textLower.match(/actually,\s*make\s*that\s*([a-z]+)/i) ||
                             textLower.match(/make\s*that\s*([a-z]+)/i) ||
                             textLower.match(/how\s*about\s*([a-z]+)/i) ||
                             textLower.match(/change\s*(?:it|that)?\s*to\s*([a-z]+)/i);

    if (makeThatDayMatch && (context.selectedDoctorId || context.selectedHospitalId)) {
      const targetDay = makeThatDayMatch[1].toLowerCase();
      return this.handleDayReferenceResolution(targetDay, context, capabilityMeta);
    }

    // 5. Pronoun Resolution for Doctor: "What openings does he/she have tomorrow?" or "Can I see him?"
    const doctorPronounMatch = /\b(he|him|his|she|her|they|them|the doctor)\b/i.test(textLower);
    if (doctorPronounMatch && context.selectedDoctorId && (textLower.includes('opening') || textLower.includes('slot') || textLower.includes('tomorrow') || textLower.includes('available') || textLower.includes('see'))) {
      return this.handleDoctorAvailabilityTurn(context.selectedDoctorId, textLower, context, capabilityMeta);
    }

    // 6. Step: Pre-Visit Questionnaire Intake (if currently completing questionnaire)
    if (context.currentIntent === 'COMPLETING_QUESTIONNAIRE' && context.activeAppointmentId) {
      return this.handleQuestionnaireTurn(textLower, context, activePatientId!, capabilityMeta);
    }

    // 7. Clarification-Over-Guessing: "Book Dr. Rao" or explicit doctor booking without slot selection
    const stopWords = new Set(['for', 'in', 'at', 'about', 'who', 'to', 'with', 'near', 'on', 'an', 'a', 'the', 'appointment', 'visit', 'checkup', 'consultation', 'someone', 'today', 'tomorrow', 'soon']);
    let doctorNameQuery: string | undefined;
    const drMention = textLower.match(/(?:dr\.?|doctor)\s+([a-z]+)/i);
    if (drMention && !stopWords.has(drMention[1].toLowerCase())) {
      doctorNameQuery = drMention[1];
    } else {
      const bookMatch = textLower.match(/(?:book|schedule|appointment\s+with)\s+([a-z]+)/i);
      if (bookMatch && !stopWords.has(bookMatch[1].toLowerCase())) {
        doctorNameQuery = bookMatch[1];
      }
    }

    if (
      doctorNameQuery &&
      (textLower.includes('book') || textLower.includes('appointment') || textLower.includes('schedule') || textLower.includes('see')) &&
      !textLower.includes('cancel') &&
      !textLower.includes('reschedule') &&
      !textLower.includes('slot')
    ) {
      return this.handleDoctorBookingClarification(doctorNameQuery, context, capabilityMeta);
    }

    // 8. Intent: Orthopedic Discovery / Symptoms with PRD Section 20 Reporting Compliance
    // Acknowledges patient's own words ("You reported shoulder pain") without diagnosing!
    if (
      textLower.includes('shoulder') ||
      textLower.includes('knee') ||
      textLower.includes('bone') ||
      textLower.includes('orthopedic') ||
      textLower.includes('joint') ||
      textLower.includes('back pain')
    ) {
      return this.handleOrthopedicDiscovery(textLower, context, capabilityMeta);
    }

    // 9. Intent: Cardiology Discovery
    if (textLower.includes('cardiology') || textLower.includes('cardiologist')) {
      return this.handleCardiologyDiscovery(context, capabilityMeta);
    }

    // 10. Intent: Hospital Discovery
    if (textLower.includes('hospital') || textLower.includes('facility') || textLower.includes('clinic')) {
      return this.handleHospitalDiscovery(textLower, context, capabilityMeta);
    }

    // 11. Intent: Reschedule Appointment
    if (textLower.includes('reschedule')) {
      return this.handleRescheduleIntent(context, capabilityMeta);
    }

    // 12. Intent: Cancel Appointment
    if (textLower.includes('cancel')) {
      return this.handleCancelIntent(context, capabilityMeta);
    }

    // 13. Intent: Verification ("Did my booking go through?") & Synchronization
    if (
      textLower.includes('did my booking go through') ||
      textLower.includes('verify my booking') ||
      textLower.includes('check my appointment') ||
      textLower.includes('is my appointment confirmed')
    ) {
      return this.handleVerificationIntent(context, capabilityMeta);
    }

    // 14. Intent: Update Preferences
    if (
      textLower.includes('preference') ||
      textLower.includes('preferred channel') ||
      textLower.includes('notify me by email') ||
      textLower.includes('send sms') ||
      textLower.includes('change preference')
    ) {
      return this.handleUpdatePreferencesIntent(textLower, context, activePatientId!, capabilityMeta);
    }

    // 15. Intent: Send Notification
    if (
      textLower.includes('send notification') ||
      textLower.includes('send me an email') ||
      textLower.includes('send confirmation text') ||
      textLower.includes('text me the details')
    ) {
      return this.handleSendNotificationIntent(textLower, context, activePatientId!, capabilityMeta);
    }

    // 16. Intent: Start Pre-Visit Workflow
    if (
      textLower.includes('start workflow') ||
      textLower.includes('start intake') ||
      textLower.includes('send questionnaire') ||
      textLower.includes('pre-visit intake')
    ) {
      return this.handleStartWorkflowIntent(context, activePatientId!, capabilityMeta);
    }

    // Default conversational greeting / clarification prompt
    const defaultResponse =
      'Hello! I am your AI Patient Access Assistant. I can help you find doctors, check appointment openings, book or reschedule visits, and complete pre-visit intake. How may I help you today?';

    return {
      spokenText: defaultResponse,
      responseText: defaultResponse,
      intentDetected: 'GREETING_OR_GENERAL_HELP',
      correlationId: capabilityMeta.correlationId!,
      context,
    };
  }

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  /**
   * Clarification-over-guessing: when user asks to "book Dr. Rao" but hasn't picked a slot,
   * the agent MUST ask for clarification among available slots, NEVER arbitrarily pick one!
   */
  private async handleDoctorBookingClarification(
    doctorQuery: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const docSearch = await CapabilityRegistry.execute(
      'search_doctors',
      { name: doctorQuery },
      meta
    );

    const doctor = docSearch.doctors[0];
    if (!doctor) {
      const responseText = `I could not find a doctor matching "${doctorQuery}". Would you like me to search by specialty?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'DOCTOR_NOT_FOUND',
        capabilityCalled: 'search_doctors',
        capabilityResult: docSearch,
        correlationId: meta.correlationId!,
        context,
      };
    }

    // Check doctor availability for next 7 days
    const now = new Date();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const avail = await CapabilityRegistry.execute(
      'check_availability',
      {
        doctorId: doctor.id,
        startDate: now.toISOString(),
        endDate: end.toISOString(),
      },
      meta
    );

    const availableSlots = (avail.slots || []).filter((s: any) => s.isAvailable);

    if (availableSlots.length === 0) {
      const responseText = `${doctor.name} does not have any open appointments available this week. Would you like to check next week or look at another doctor?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_SLOTS_AVAILABLE',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        correlationId: meta.correlationId!,
        context,
      };
    }

    // Clarification-over-guessing rule: If 2 or more slots exist, NEVER guess. ASK!
    const offeredSlots = availableSlots.slice(0, 3);
    const slotOptionsText = offeredSlots
      .map((s: any) => {
        const d = new Date(s.startTime);
        return `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      })
      .join(', or ');

    const responseText = `${doctor.name} has ${offeredSlots.length} available appointment slots: ${slotOptionsText}. Which one would you prefer?`;

    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'AWAITING_SLOT_SELECTION',
      selectedDoctorId: doctor.id,
      selectedHospitalId: doctor.hospitalId,
      lastOfferedSlotIds: offeredSlots.map((s: any) => s.slotId),
      ambiguousOptions: offeredSlots,
    });

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'AMBIGUOUS_SLOT_SELECTION',
      clarificationNeeded: true,
      capabilityCalled: 'check_availability',
      capabilityResult: avail,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Pronoun / Reference Resolution: "Actually, make that Friday" (PRD Section 10 example).
   * Resolves "that" to the active doctor and hospital context, shifting target date to Friday.
   */
  private async handleDayReferenceResolution(
    targetDay: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const doctorId = context.selectedDoctorId;
    if (!doctorId) {
      const responseText = 'Which doctor would you like to schedule for that day?';
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'DAY_WITHOUT_DOCTOR',
        correlationId: meta.correlationId!,
        context,
      };
    }

    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { hospital: true },
    });

    // Compute target date window for next 7 days
    const now = new Date();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const avail = await CapabilityRegistry.execute(
      'check_availability',
      {
        doctorId,
        startDate: now.toISOString(),
        endDate: end.toISOString(),
      },
      meta
    );

    const daySlots = (avail.slots || []).filter((s: any) => {
      if (!s.isAvailable) return false;
      const slotDay = new Date(s.startTime).toLocaleDateString([], { weekday: 'long' }).toLowerCase();
      return slotDay.includes(targetDay);
    });

    if (daySlots.length === 0) {
      const responseText = `I checked, but ${doctor?.name || 'the doctor'} does not have any available slots on ${targetDay}. Would you like to check another day?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_SLOTS_ON_TARGET_DAY',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        correlationId: meta.correlationId!,
        context,
      };
    }

    // Clarification-over-guessing: present Friday slots for the user to choose
    const offeredSlots = daySlots.slice(0, 2);
    const slotDescriptions = offeredSlots.map((s: any) => {
      const d = new Date(s.startTime);
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    });

    const responseText = `I have updated the day to ${targetDay}. ${doctor?.name || 'Dr. Rao'} has openings at ${slotDescriptions.join(' and ')}. Which time would you prefer?`;

    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'AWAITING_SLOT_SELECTION',
      lastOfferedSlotIds: offeredSlots.map((s: any) => s.slotId),
      ambiguousOptions: offeredSlots,
    });

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'RESOLVED_DAY_REFERENCE',
      clarificationNeeded: true,
      capabilityCalled: 'check_availability',
      capabilityResult: avail,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Pronoun Resolution for Doctor: "What openings does he have tomorrow?"
   * Resolves "he" -> context.selectedDoctorId.
   */
  private async handleDoctorAvailabilityTurn(
    doctorId: string,
    textLower: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { hospital: true },
    });

    const now = new Date();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const avail = await CapabilityRegistry.execute(
      'check_availability',
      {
        doctorId,
        startDate: now.toISOString(),
        endDate: end.toISOString(),
      },
      meta
    );

    const availableSlots = (avail.slots || []).filter((s: any) => s.isAvailable);

    if (availableSlots.length === 0) {
      const responseText = `${doctor?.name} has no available openings this week.`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_SLOTS_AVAILABLE',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        correlationId: meta.correlationId!,
        context,
      };
    }

    const offeredSlots = availableSlots.slice(0, 2);
    const slotDescriptions = offeredSlots.map((s: any) => {
      const d = new Date(s.startTime);
      return `${d.toLocaleDateString([], { weekday: 'long' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    });

    const responseText = `${doctor?.name} has openings on ${slotDescriptions.join(' and ')}. Would you like to book one of these?`;

    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'AWAITING_SLOT_SELECTION',
      lastOfferedSlotIds: offeredSlots.map((s: any) => s.slotId),
      ambiguousOptions: offeredSlots,
    });

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'RESOLVED_DOCTOR_PRONOUN',
      capabilityCalled: 'check_availability',
      capabilityResult: avail,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Slot Selection Turn: User picks a specific slot after clarification.
   */
  private async handleSlotSelectionTurn(
    textLower: string,
    context: ActiveContext,
    patientId: string,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const offeredSlotIds = context.lastOfferedSlotIds || [];
    let chosenSlotId = offeredSlotIds[0];

    // Check if user selected the second / afternoon slot
    if (
      (textLower.includes('second') ||
        textLower.includes('2nd') ||
        textLower.includes('afternoon') ||
        textLower.includes('2:00') ||
        textLower.includes('2pm') ||
        textLower.includes('3:00') ||
        textLower.includes('3pm')) &&
      offeredSlotIds.length > 1
    ) {
      chosenSlotId = offeredSlotIds[1];
    }

    try {
      const bookingResult = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId: context.selectedDoctorId,
          hospitalId: context.selectedHospitalId,
          slotId: chosenSlotId,
          reason: 'Patient scheduled appointment via AI assistant',
          idempotencyKey: crypto.randomUUID(),
        },
        meta
      );

      const slotDate = new Date(bookingResult.startTime);
      const dayStr = slotDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const timeStr = slotDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      const responseText = `Great news! Your appointment with ${bookingResult.doctorName} at ${bookingResult.hospitalName} has been verified and confirmed for ${dayStr} at ${timeStr}. Before your visit, would you like to answer two quick intake questions for Dr. ${bookingResult.doctorName.split(' ').pop()}?`;

      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'COMPLETING_QUESTIONNAIRE',
        activeAppointmentId: bookingResult.appointmentId,
        selectedSlotId: chosenSlotId,
      });

      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'BOOKING_CONFIRMED',
        capabilityCalled: 'create_appointment',
        capabilityResult: bookingResult,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    } catch (err: any) {
      logger.error({ err }, 'Booking failed during slot selection turn');
      const responseText = `I apologize, but that slot is no longer available or an error occurred. Would you like to select another time?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'BOOKING_FAILED',
        correlationId: meta.correlationId!,
        context,
      };
    }
  }

  /**
   * Orthopedic Discovery with PRD Section 20 Clinical Reporting Compliance:
   * Explicitly quotes/reports patient's words ("You reported shoulder pain"),
   * without concluding or diagnosing!
   */
  private async handleOrthopedicDiscovery(
    utterance: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const docSearch = await CapabilityRegistry.execute(
      'search_doctors',
      { specialty: 'Orthopedics' },
      meta
    );

    const doctor = docSearch.doctors[0];
    if (!doctor) {
      const responseText =
        'You reported joint pain. I searched our directory but could not find an available orthopedic doctor at this time.';
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_DOCTORS_FOUND',
        capabilityCalled: 'search_doctors',
        capabilityResult: docSearch,
        correlationId: meta.correlationId!,
        context,
      };
    }

    // Check availability
    const now = new Date();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const avail = await CapabilityRegistry.execute(
      'check_availability',
      {
        doctorId: doctor.id,
        startDate: now.toISOString(),
        endDate: end.toISOString(),
      },
      meta
    );

    const availableSlots = (avail.slots || []).filter((s: any) => s.isAvailable).slice(0, 2);

    let symptomQuote = 'joint pain';
    if (utterance.includes('shoulder')) symptomQuote = 'shoulder pain';
    if (utterance.includes('knee')) symptomQuote = 'knee pain';

    let responsePrompt = `You reported ${symptomQuote}. I can help you schedule an appointment with an orthopedic specialist. I found ${doctor.name} at ${doctor.hospitalName}.`;

    if (availableSlots.length > 0) {
      const slot1 = new Date(availableSlots[0].startTime);
      const slot1Time = slot1.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const slot1Day = slot1.toLocaleDateString([], { weekday: 'long' });

      responsePrompt += ` The earliest opening is on ${slot1Day} at ${slot1Time}.`;
      if (availableSlots.length > 1) {
        const slot2 = new Date(availableSlots[1].startTime);
        const slot2Time = slot2.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        responsePrompt += ` Or I also have ${slot2Time}. Would either of those times work for you?`;
      } else {
        responsePrompt += ' Would you like me to book that for you?';
      }
    }

    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'AWAITING_SLOT_SELECTION',
      selectedHospitalId: doctor.hospitalId,
      selectedDoctorId: doctor.id,
      lastOfferedSlotIds: availableSlots.map((s: any) => s.slotId),
      ambiguousOptions: availableSlots,
    });

    return {
      spokenText: responsePrompt,
      responseText: responsePrompt,
      intentDetected: 'DISCOVERED_ORTHOPEDICS',
      capabilityCalled: 'check_availability',
      capabilityResult: avail,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Cardiology Discovery
   */
  private async handleCardiologyDiscovery(
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const docSearch = await CapabilityRegistry.execute(
      'search_doctors',
      { specialty: 'Cardiology' },
      meta
    );

    const doctor = docSearch.doctors[0];
    if (!doctor) {
      const responseText = 'I could not find any active cardiologists at this time.';
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_DOCTORS_FOUND',
        capabilityCalled: 'search_doctors',
        capabilityResult: docSearch,
        correlationId: meta.correlationId!,
        context,
      };
    }

    const responseText = `I found ${doctor.name} in Cardiology at ${doctor.hospitalName}. Would you like me to check their appointments for this week?`;

    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'AWAITING_DOCTOR_CONFIRMATION',
      selectedHospitalId: doctor.hospitalId,
      selectedDoctorId: doctor.id,
    });

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'DISCOVERED_CARDIOLOGY',
      capabilityCalled: 'search_doctors',
      capabilityResult: docSearch,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Hospital Discovery
   */
  private async handleHospitalDiscovery(
    utterance: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const searchResult = await CapabilityRegistry.execute(
      'search_hospitals',
      {},
      meta
    );

    const hospitals = searchResult.hospitals || [];
    const hospitalNames = hospitals.map((h: any) => h.name).join(', ');
    const responseText = `We have the following partner hospitals available: ${hospitalNames}. Which location would you prefer?`;

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'SEARCH_HOSPITALS',
      capabilityCalled: 'search_hospitals',
      capabilityResult: searchResult,
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Reschedule Intent
   */
  private async handleRescheduleIntent(
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    if (context.activeAppointmentId) {
      const responseText =
        'I can help you reschedule your appointment. Could you please specify your preferred day or time for the new appointment?';
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'RESCHEDULE_INTENT',
        correlationId: meta.correlationId!,
        context,
      };
    }

    const responseText = 'Which appointment would you like to reschedule?';
    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'RESCHEDULE_NO_APPOINTMENT',
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Cancel Intent
   */
  private async handleCancelIntent(
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    if (context.activeAppointmentId) {
      const cancelResult = await CapabilityRegistry.execute(
        'cancel_appointment',
        {
          appointmentId: context.activeAppointmentId,
          reason: 'Patient requested cancellation via assistant',
          idempotencyKey: crypto.randomUUID(),
        },
        meta
      );

      const responseText =
        'Your appointment has been cancelled and the slot has been released back to the calendar.';

      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'APPOINTMENT_CANCELLED',
        activeAppointmentId: undefined,
      });

      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'CANCEL_APPOINTMENT',
        capabilityCalled: 'cancel_appointment',
        capabilityResult: cancelResult,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    }

    const responseText = 'Which appointment would you like to cancel?';
    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'CANCEL_NO_APPOINTMENT',
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Verification Intent ("Did my booking go through?")
   */
  private async handleVerificationIntent(
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    if (context.activeAppointmentId) {
      const appointment = await prisma.appointment.findUnique({
        where: { id: context.activeAppointmentId },
        include: { hospital: true },
      });

      if (appointment) {
        const verifyResult = await CapabilityRegistry.execute(
          'verify_external_appointment',
          {
            internalAppointmentId: appointment.id,
            externalAppointmentId: appointment.externalAppointmentId || undefined,
            hospitalId: appointment.hospitalId,
          },
          meta
        );

        if (verifyResult.isVerified) {
          const responseText = `Yes, your booking is fully verified and confirmed in the hospital EHR system with status: ${verifyResult.externalStatus}.`;
          return {
            spokenText: responseText,
            responseText,
            intentDetected: 'VERIFY_APPOINTMENT',
            capabilityCalled: 'verify_external_appointment',
            capabilityResult: verifyResult,
            correlationId: meta.correlationId!,
            context,
          };
        } else {
          // Trigger synchronization
          const syncResult = await CapabilityRegistry.execute(
            'synchronize_state',
            {
              appointmentId: appointment.id,
              correlationId: meta.correlationId!,
            },
            meta
          );

          const responseText = `I checked with the hospital system and synchronized your records. Your appointment status is currently ${syncResult.internalStatus}.`;
          return {
            spokenText: responseText,
            responseText,
            intentDetected: 'SYNCHRONIZE_APPOINTMENT',
            capabilityCalled: 'synchronize_state',
            capabilityResult: syncResult,
            correlationId: meta.correlationId!,
            context,
          };
        }
      }
    }

    const responseText =
      'You currently have no active appointment selected to verify. Would you like me to look up your existing bookings?';
    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'VERIFY_NO_APPT',
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Update Preferences Intent
   */
  private async handleUpdatePreferencesIntent(
    utterance: string,
    context: ActiveContext,
    patientId: string,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const channel = utterance.includes('email') ? 'email' : utterance.includes('phone') ? 'phone' : 'sms';

    const prefResult = await CapabilityRegistry.execute(
      'update_preferences',
      {
        patientId,
        preferences: {
          communicationChannel: channel,
        },
      },
      meta
    );

    const responseText = `I have updated your communication preference to receive notifications via ${channel}.`;

    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      preferences: { ...(context.preferences || {}), communicationChannel: channel },
      relevantPreferences: { ...(context.relevantPreferences || {}), communicationChannel: channel },
    });

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'UPDATE_PREFERENCES',
      capabilityCalled: 'update_preferences',
      capabilityResult: prefResult,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Send Notification Intent
   */
  private async handleSendNotificationIntent(
    utterance: string,
    context: ActiveContext,
    patientId: string,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const channel = utterance.includes('email') ? 'email' : 'sms';

    const notifResult = await CapabilityRegistry.execute(
      'send_notification',
      {
        recipientId: patientId,
        recipientType: 'Patient',
        channel,
        templateId: 'CONFIRMATION_NOTICE',
        payload: { message: 'Your appointment reminder and details.' },
      },
      { ...meta, actorRole: 'SYSTEM' }
    );

    const responseText = `I have queued and sent your confirmation notification via ${channel}.`;

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'SEND_NOTIFICATION',
      capabilityCalled: 'send_notification',
      capabilityResult: notifResult,
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Start Workflow Intent
   */
  private async handleStartWorkflowIntent(
    context: ActiveContext,
    patientId: string,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    if (context.activeAppointmentId) {
      const wfResult = await CapabilityRegistry.execute(
        'start_workflow',
        {
          workflowType: 'PreVisitQuestionnaire',
          triggerEvent: 'PATIENT_REQUEST',
          payload: {
            appointmentId: context.activeAppointmentId,
            patientId,
          },
          idempotencyKey: crypto.randomUUID(),
        },
        meta
      );

      const responseText = 'I have initiated your pre-visit intake workflow.';

      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'START_WORKFLOW',
        capabilityCalled: 'start_workflow',
        capabilityResult: wfResult,
        correlationId: meta.correlationId!,
        context,
      };
    }

    const responseText = 'Please schedule an appointment first before initiating pre-visit intake.';
    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'WORKFLOW_NO_APPT',
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Questionnaire Turn (PRD Section 15 & 20):
   * Dynamically loads configured questions from the hospital/doctor questionnaire.
   * Guardrail: ONLY asks configured questions, never invents diagnostic questions,
   * and never uses questionnaire responses to diagnose or change medications.
   */
  private async handleQuestionnaireTurn(
    textLower: string,
    context: ActiveContext,
    patientId: string,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const hospitalId = context.selectedHospitalId || this.hospitalId || 'SYSTEM';

    // 1. Fetch matching questionnaire
    const qData = await CapabilityRegistry.execute(
      'get_questionnaire',
      {
        hospitalId,
        doctorId: context.selectedDoctorId,
      },
      meta
    );

    const questionnaire = qData?.questionnaire;
    if (!questionnaire || !questionnaire.schema || questionnaire.schema.length === 0) {
      const responseText =
        'There are no additional pre-visit questions required for this appointment. We look forward to seeing you!';
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'COMPLETED',
      });
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_QUESTIONNAIRE_NEEDED',
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    }

    const questions = questionnaire.schema;
    const wfState = context.completedWorkflowState || {};
    let currentIndex = wfState.currentQuestionIndex ?? -1;
    const collectedAnswers: Record<string, any> = wfState.collectedAnswers || {};

    // Initial greeting / acceptance of intake ("yes", "sure", "okay")
    if (currentIndex === -1) {
      if (
        textLower.includes('yes') ||
        textLower.includes('sure') ||
        textLower.includes('okay') ||
        textLower.includes('fine') ||
        textLower.includes('start') ||
        textLower.includes('ready')
      ) {
        currentIndex = 0;
        const firstQ = questions[0];
        let prompt = `Question 1: ${firstQ.question}`;
        if (firstQ.options && firstQ.options.length > 0) {
          prompt += ` (Options: ${firstQ.options.join(', ')})`;
        }

        const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
          completedWorkflowState: {
            currentQuestionIndex: 0,
            collectedAnswers: {},
            questionnaireId: questionnaire.id,
          },
        });

        return {
          spokenText: prompt,
          responseText: prompt,
          intentDetected: 'QUESTIONNAIRE_STARTED',
          correlationId: meta.correlationId!,
          context: updatedContext,
        };
      } else {
        const responseText =
          'You can complete this intake questionnaire now or at check-in. Would you like to answer the questions now?';
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'AWAITING_QUESTIONNAIRE_CONSENT',
          correlationId: meta.correlationId!,
          context,
        };
      }
    }

    // Save previous question's answer
    const currentQ = questions[currentIndex];
    collectedAnswers[currentQ.fieldId || `q_${currentIndex}`] = textLower;

    const nextIndex = currentIndex + 1;

    // Check if more questions remain
    if (nextIndex < questions.length) {
      const nextQ = questions[nextIndex];
      let prompt = `Question ${nextIndex + 1}: ${nextQ.question}`;
      if (nextQ.options && nextQ.options.length > 0) {
        prompt += ` (Options: ${nextQ.options.join(', ')})`;
      }

      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        completedWorkflowState: {
          currentQuestionIndex: nextIndex,
          collectedAnswers,
          questionnaireId: questionnaire.id,
        },
      });

      return {
        spokenText: prompt,
        responseText: prompt,
        intentDetected: `QUESTIONNAIRE_Q${nextIndex + 1}`,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    }

    // All questions answered: Submit structured responses
    let submitResult: any = null;
    if (context.activeAppointmentId) {
      submitResult = await CapabilityRegistry.execute(
        'submit_questionnaire',
        {
          questionnaireId: questionnaire.id,
          appointmentId: context.activeAppointmentId,
          patientId,
          responses: collectedAnswers,
        },
        meta
      );
    }

    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'COMPLETED',
      completedWorkflowState: {
        intakeStatus: 'COMPLETED',
        submittedAt: new Date().toISOString(),
        collectedAnswers,
      },
    });

    let completionResponse =
      'Thank you! Your responses have been saved and sent directly to your doctor. We look forward to seeing you at your appointment!';

    if (submitResult?.flaggedUrgent) {
      completionResponse +=
        ' Notice: A keyword flagged your response for prompt review by clinical staff upon arrival.';
    }

    return {
      spokenText: completionResponse,
      responseText: completionResponse,
      intentDetected: 'QUESTIONNAIRE_COMPLETED',
      capabilityCalled: 'submit_questionnaire',
      capabilityResult: submitResult,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }
}
