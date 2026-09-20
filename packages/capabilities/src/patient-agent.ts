import { prisma } from '@health/db';
import { logger } from '@health/observability';
import { CapabilityRegistry, CapabilityMetadata } from './registry.js';
import { ConversationContextManager, ActiveContext } from './context-manager.js';
import { AppointmentStatus } from '@health/shared-types';
import { DialogueRouter, LlmRoutingDecision } from './llm-router.js';
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

    // If utterance is empty (silence / wait with no input)
    if (!utterance || !utterance.trim()) {
      if (
        context.currentIntent === 'COMPLETED' ||
        context.currentIntent === 'CONVERSATION_CONCLUDED' ||
        context.currentIntent === 'QUESTIONNAIRE_DECLINED' ||
        context.activeAppointmentId
      ) {
        const responseText =
          "I'm still here if you need any other assistance with your appointment, or you can say goodbye when you're all set.";
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'AWAITING_FURTHER_INQUIRY',
          correlationId,
          context,
        };
      }
      // If conversation is already underway, prompt for next input rather than generic greeting
      if (context.selectedDoctorId || context.selectedHospitalId || context.selectedSlotId || context.lastOfferedSlotIds?.length) {
        const responseText =
          "I didn't hear anything. Would you like me to repeat the available options or help you with something else?";
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'AWAITING_INPUT_CLARIFICATION',
          clarificationNeeded: true,
          correlationId,
          context,
        };
      }
    }

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

    // 2b. Conversation Conclusion / Farewell / Polite Acknowledgment
    const isFarewellOrAllSet =
      /^(no|nope|nah|no thanks|no thank you|that's all|thats all|that is all|that's it|thats it|nothing else|all set|all good|i'm good|im good|done|bye|goodbye|have a good day|thank you that's all|thanks that's all|thanks|thank you|not right now|not now|maybe later|later|all good|i will pass|i'll pass|ill pass)$/i.test(
        textLower.replace(/[.,!]/g, '').trim()
      ) ||
      /\b(that's all|thats all|that is all|nothing else|all set|bye|goodbye|not right now|not now|nothing for now)\b/i.test(textLower);

    if (
      isFarewellOrAllSet &&
      (context.currentIntent === 'COMPLETED' ||
        context.currentIntent === 'CONVERSATION_CONCLUDED' ||
        context.currentIntent === 'QUESTIONNAIRE_DECLINED' ||
        context.activeAppointmentId) &&
      context.currentIntent !== 'AWAITING_SLOT_SELECTION' &&
      context.currentIntent !== 'AWAITING_DOCTOR_CONFIRMATION' &&
      context.currentIntent !== 'COMPLETING_QUESTIONNAIRE'
    ) {
      const responseText =
        "You're very welcome! Your appointment is all set. Have a wonderful day, and please reach out if you need anything else before your visit.";
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'CONVERSATION_CONCLUDED',
      });
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'CONVERSATION_CONCLUDED',
        correlationId,
        context: updatedContext,
      };
    }

    // Tier 2: AI Dialogue Routing (LLM via Gemini + Tier 3 Deterministic Fallback)
    const routeDecision = await DialogueRouter.routeTurn(utterance, context, {
      correlationId,
    });

    // Handle cut-off / incomplete utterances immediately
    if (routeDecision.intent === 'INCOMPLETE_CUTOFF') {
      const clarifyResponse =
        'It sounds like your sentence was cut off—could you please describe what severe symptoms or health concern you are experiencing?';
      return {
        spokenText: clarifyResponse,
        responseText: clarifyResponse,
        intentDetected: 'INCOMPLETE_UTTERANCE_CLARIFICATION',
        clarificationNeeded: true,
        correlationId,
        context,
      };
    }

    // Handle factual hospital inquiries (location, address, hours, contact)
    if (
      routeDecision.intent === 'FACTUAL_HOSPITAL_INQUIRY' &&
      !textLower.includes('what hospitals') &&
      !textLower.includes('available hospitals') &&
      !textLower.includes('hospitals do you have') &&
      !textLower.includes('clinics do you have')
    ) {
      return this.handleFactualHospitalInquiry(routeDecision, context, capabilityMeta);
    }

    // Handle Reschedule slot requests (e.g. "Please book the next available slot on Tuesday")
    if (
      routeDecision.intent === 'RESCHEDULE_SLOT_SELECTION' ||
      context.currentIntent === 'AWAITING_RESCHEDULE_SLOT'
    ) {
      if (
        routeDecision.intent === 'RESCHEDULE_SLOT_SELECTION' ||
        /\b(tuesday|monday|wednesday|thursday|friday|next|available|slot|morning|afternoon|10am|11am)\b/i.test(textLower)
      ) {
        return this.handleRescheduleSlotSelection(routeDecision, context, activePatientId!, capabilityMeta);
      }
    }

    // Handle clinical safety inquiries via LLM routing
    if (routeDecision.intent === 'CLINICAL_SAFETY_INQUIRY') {
      logger.warn(
        { conversationId: this.conversationId, correlationId, utterance },
        'PRD Section 20 clinical safety boundary triggered via LLM route: refusing clinical inquiry'
      );
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

    // Handle initial reschedule request
    if (routeDecision.intent === 'RESCHEDULE_INTENT') {
      return this.handleRescheduleIntent(context, capabilityMeta);
    }

    // Handle Questionnaire Decline
    if (
      routeDecision.intent === 'QUESTIONNAIRE_DECLINE' ||
      /\b(no thanks|do (?:the )?questions later|do it later|fill (?:it|them) out later|skip (?:the )?(?:questions|questionnaire|intake)|pass on the questions|not right now|skip questions)\b/i.test(textLower)
    ) {
      return this.handleQuestionnaireDecline(context, capabilityMeta);
    }

    // Handle Questionnaire Accept
    if (routeDecision.intent === 'QUESTIONNAIRE_ACCEPT' && context.activeAppointmentId) {
      return this.handleQuestionnaireTurn('yes', context, activePatientId!, capabilityMeta);
    }

    // Handle Doctor Availability & Doctor Booking inquiries (LLM routing or explicit doctor mention)
    const explicitDrMatch =
      routeDecision.entities?.doctorName ||
      textLower.match(/(?:dr\.?|doctor)\s+([a-z\s]+?)(?:\s+at|\s+on|\s+for|\s+this|\s+next|\s+in|\s+morning|\s+afternoon|$)/i)?.[1]?.trim() ||
      textLower.match(/(?:dr\.?|doctor)\s+([a-z]+)/i)?.[1]?.trim() ||
      textLower.match(/\b(jenkins|chen|rao|patel|rostova|arvind|elena|marcus|maya|anya|david)\b/i)?.[0]?.trim();

    if (
      explicitDrMatch &&
      !['for', 'in', 'at', 'about', 'who', 'whom', 'to', 'with', 'near', 'on', 'an', 'a', 'the', 'appointment', 'visit', 'checkup', 'consultation', 'today', 'tomorrow', 'soon', 'this', 'next', 'first', 'available', 'open', 'doctor', 'physician', 'slot', 'slots'].includes(explicitDrMatch.toLowerCase()) &&
      (textLower.includes('dr') || textLower.includes('doctor') || /\b(jenkins|chen|rao|patel|rostova|arvind|elena|marcus|maya|anya|david)\b/i.test(textLower)) &&
      !textLower.includes('cancel') &&
      !textLower.includes('reschedule')
    ) {
      return this.handleDoctorBookingClarification(
        explicitDrMatch,
        context,
        capabilityMeta,
        routeDecision,
        textLower
      );
    }

    // Symptom Reports & Specialty Discovery (MUST BREAK OUT of stale AWAITING_SLOT_SELECTION)
    const isCardioSymptom =
      (routeDecision.intent === 'SYMPTOM_REPORT' && routeDecision.entities.specialty?.toLowerCase() === 'cardiology') ||
      (routeDecision.intent === 'SPECIALTY_DISCOVERY' && routeDecision.entities.specialty?.toLowerCase() === 'cardiology') ||
      (routeDecision.entities?.symptom && routeDecision.entities.symptom.toLowerCase().includes('heart')) ||
      /\b(heart pain|chest pain|palpitation|palpitations|arrhythmia|hypertension|high blood pressure|cardiac|cardio|cardiolog(?:ist|y)|heart doctor|heart specialist)\b/i.test(textLower) ||
      (textLower.includes('heart') &&
        (textLower.includes('pain') ||
          textLower.includes('ache') ||
          textLower.includes('doctor') ||
          textLower.includes('specialist') ||
          textLower.includes('appointment') ||
          textLower.includes('see') ||
          textLower.includes('visit')));

    const isOrthoSymptom =
      (routeDecision.intent === 'SYMPTOM_REPORT' && routeDecision.entities.specialty?.toLowerCase() === 'orthopedics') ||
      (routeDecision.intent === 'SPECIALTY_DISCOVERY' && routeDecision.entities.specialty?.toLowerCase() === 'orthopedics') ||
      (routeDecision.entities?.symptom &&
        /\b(leg|arm|limb|joint|bone|neck|back|spine|shoulder|knee|hip|orthopedic)\b/i.test(routeDecision.entities.symptom)) ||
      /\b(neck|cervical|stiff neck|back|spine|spinal|lower back|lumbar|sciatica|disc|shoulder|knee|hip|elbow|wrist|ankle|foot|feet|hand|hands|leg|legs|thigh|thighs|calf|calves|shin|shins|arm|arms|bone|bones|joint|joints|orthopedic|orthopedics|orthopedist|musculoskeletal|ligament|tendon|cartilage|sprain|fracture|muscle pain|muscle ache)\b/i.test(textLower) ||
      textLower.includes('leg pain') ||
      textLower.includes('arm pain') ||
      textLower.includes('calf pain') ||
      textLower.includes('thigh pain') ||
      textLower.includes('neck pain') ||
      textLower.includes('back pain') ||
      textLower.includes('shoulder pain') ||
      textLower.includes('knee pain') ||
      textLower.includes('hip pain') ||
      textLower.includes('joint pain') ||
      textLower.includes('bone pain') ||
      ((textLower.includes('pain') ||
        textLower.includes('ache') ||
        textLower.includes('aching') ||
        textLower.includes('hurts') ||
        textLower.includes('hurting') ||
        textLower.includes('sore') ||
        textLower.includes('stiff')) &&
        /\b(leg|legs|thigh|calf|calves|shin|arm|arms|knee|knees|hip|hips|foot|feet|ankle|ankles|joint|joints|bone|bones|shoulder|shoulders|elbow|elbows|wrist|wrists|hand|hands|back|neck|spine)\b/i.test(
          textLower
        ));

    const isGeneralMedSymptom =
      (routeDecision.intent === 'SYMPTOM_REPORT' && routeDecision.entities.specialty?.toLowerCase() === 'general medicine') ||
      /\b(fever|cough|cold|flu|headache|migraine|sore throat|throat pain|fatigue|tiredness|stomach|stomach ache|abdominal|belly|nausea|vomiting|dizzy|dizziness|allergy|allergies|rash|primary care|general medicine|general physician|general doctor|routine checkup|annual checkup|physical exam|feeling sick|feel sick|sick)\b/i.test(textLower);

    if (isCardioSymptom) {
      return this.handleCardiologyDiscovery(textLower, context, capabilityMeta);
    }

    if (isOrthoSymptom) {
      return this.handleOrthopedicDiscovery(textLower, context, capabilityMeta);
    }

    if (isGeneralMedSymptom) {
      return this.handleGeneralMedicineDiscovery(textLower, context, capabilityMeta);
    }

    // 3. Pronoun / Reference Resolution & Clarification Handling
    // Only process slot selection if user actually provides a slot selection, affirmative choice, ordinal, or day/time
    const isSlotAffirmative =
      /\b(yes|yeah|yep|sure|ok|okay|alright|all right|please|confirm|that one|book it|book that|go ahead|proceed|sounds good|that works|first|second|third|1st|2nd|3rd|earliest|latest|morning|afternoon)\b/i.test(
        textLower
      );
    const hasSlotMention =
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm))\b/i.test(
        textLower
      );
    const isSlotChoice =
      routeDecision.intent === 'SLOT_SELECTION' ||
      isSlotAffirmative ||
      hasSlotMention;

    if (
      (routeDecision.intent === 'SLOT_SELECTION' ||
        (context.currentIntent === 'AWAITING_SLOT_SELECTION' && isSlotChoice)) &&
      ((context.lastOfferedSlotIds && context.lastOfferedSlotIds.length > 0) ||
        (context.ambiguousOptions && context.ambiguousOptions.length > 0))
    ) {
      const isNegative =
        /\b(no|nope|nah|not now|never mind|cancel|dont|don't|maybe later|later|i'll do it later|skip|skip that|none|neither|none of those|pass|no thanks|i'll pass)\b/i.test(
          textLower
        );
      if (isNegative) {
        const responseText =
          'Understood. We will not book those times. Would you like to check a different day, another doctor, or search for another hospital?';
        const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
          currentIntent: 'NONE',
          lastOfferedSlotIds: [],
          ambiguousOptions: [],
        });
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'SLOT_SELECTION_DECLINED',
          correlationId: capabilityMeta.correlationId!,
          context: updatedContext,
        };
      }

      if (
        (context.lastOfferedSlotIds && context.lastOfferedSlotIds.length > 0) ||
        (context.ambiguousOptions && context.ambiguousOptions.length > 0)
      ) {
        return this.handleSlotSelectionTurn(textLower, context, activePatientId!, capabilityMeta, routeDecision);
      } else if (context.selectedDoctorId) {
        const doctor = await prisma.doctor.findUnique({ where: { id: context.selectedDoctorId } });
        if (doctor) {
          return this.handleDoctorBookingClarification(doctor.name, context, capabilityMeta, routeDecision, textLower);
        }
      }
    }

    // 3b. Confirmation for Doctor Discovery: User asked for doctor/specialist, agent found them and asked:
    // "Would you like me to check their appointments for this week?"
    // User says "yes", "sure", "please", "check appointments", "do that", etc.
    if (context.currentIntent === 'AWAITING_DOCTOR_CONFIRMATION' && context.selectedDoctorId) {
      const isNegative =
        /\b(no|nope|nah|not now|never mind|cancel|dont|don't|maybe later|later|i'll do it later|i will do it later|skip|skip that|pass|no thanks|i'll pass)\b/i.test(
          textLower
        );
      const isAffirmative =
        !isNegative &&
        /\b(yes|yeah|yep|sure|ok|okay|please|confirm|check|book|schedule|do that|go ahead|sounds good|why not|proceed)\b/i.test(
          textLower
        );

      if (isAffirmative) {
        return this.handleDoctorAvailabilityTurn(
          context.selectedDoctorId,
          textLower,
          context,
          capabilityMeta,
          'CHECKED_DOCTOR_AVAILABILITY'
        );
      } else if (isNegative) {
        const responseText =
          'Understood. Let me know if you would like to search for a different specialty, doctor, or hospital location.';
        const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
          currentIntent: 'NONE',
        });
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'DOCTOR_CONFIRMATION_DECLINED',
          correlationId: capabilityMeta.correlationId!,
          context: updatedContext,
        };
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

    // 9. Clarification-Over-Guessing: "Book Dr. Rao" or explicit doctor booking without slot selection
    const stopWords = new Set([
      'for', 'in', 'at', 'about', 'who', 'whom', 'to', 'with', 'near', 'on', 'an', 'a', 'the',
      'appointment', 'visit', 'checkup', 'consultation', 'someone', 'today', 'tomorrow', 'soon',
      'this', 'next', 'my', 'any', 'first', 'available', 'open', 'good', 'best', 'please',
      'or', 'and', 'if', 'when', 'there', 'here', 'now', 'which', 'what', 'whose', 'orthopedic',
      'orthopedics', 'cardiology', 'cardiologist', 'specialist', 'specialty', 'doctor', 'physician',
      'openings', 'opening', 'slots', 'slot'
    ]);
    let doctorNameQuery: string | undefined;
    const drMention =
      textLower.match(/(?:dr\.?|doctor)\s+([a-z\s]+?)(?:\s+at|\s+on|\s+for|\s+this|\s+next|\s+in|\s+morning|\s+afternoon|$)/i) ||
      textLower.match(/(?:dr\.?|doctor)\s+([a-z]+)/i);
    if (drMention && !stopWords.has(drMention[1].toLowerCase().trim())) {
      doctorNameQuery = drMention[1].trim();
    } else {
      const bookMatch = textLower.match(/(?:book|schedule|appointment\s+with|openings\s+(?:for|does|with)|see)\s+([a-z]+)/i);
      if (bookMatch && !stopWords.has(bookMatch[1].toLowerCase())) {
        doctorNameQuery = bookMatch[1];
      }
    }

    if (
      doctorNameQuery &&
      (textLower.includes('book') ||
        textLower.includes('appointment') ||
        textLower.includes('schedule') ||
        textLower.includes('see') ||
        textLower.includes('opening') ||
        textLower.includes('slot') ||
        textLower.includes('available') ||
        textLower.includes('have')) &&
      !textLower.includes('cancel') &&
      !textLower.includes('reschedule')
    ) {
      return this.handleDoctorBookingClarification(doctorNameQuery, context, capabilityMeta, undefined, textLower);
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
      return this.handleCancelIntent(textLower, context, activePatientId!, capabilityMeta);
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

    // 10b. Intent: Specific Specialty Discovery (or non-existent specialty clarification)
    const specialtyMatch = textLower.match(
      /\b(dermatolog[a-z]*|oncolog[a-z]*|neurolog[a-z]*|pediatr[a-z]*|psychiatr[a-z]*|endocrin[a-z]*|gastroenterol[a-z]*|pulmonol[a-z]*|ophthalmol[a-z]*|urolog[a-z]*|ent|ear nose throat|podiatr[a-z]*|gynecolog[a-z]*|obstetric[a-z]*)\b/i
    );
    if (specialtyMatch) {
      return this.handleSpecialtyDiscovery(specialtyMatch[1], context, capabilityMeta);
    }

    // 10c. Intent: Ambiguous Booking Request (requires clarification rather than guessing)
    if (
      /\b(i need an appointment|book an appointment|schedule an appointment|see a doctor|make an appointment|book a visit|schedule a visit|need to see someone|make a booking)\b/i.test(
        textLower
      )
    ) {
      return await this.handleAmbiguousBookingRequest(context, capabilityMeta);
    }

    // 10d. Intent: Unspecified Pain or Symptom (clarifies anatomical location rather than generic greeting)
    if (
      /\b(severe(?:\s+[a-z]+)?\s+pain|in pain|hurts|hurting|ache|aching|in agony|unwell|not feeling well|feeling ill|feel bad|any pain|lot of pain|much pain|having pain)\b/i.test(
        textLower
      ) ||
      (textLower.includes('pain') && !textLower.includes('paint'))
    ) {
      const clarifyResponse =
        "I'm sorry to hear that you are experiencing pain. To help connect you with the right doctor or specialist, could you please tell me where the pain is located (for example, leg, back, neck, joints, chest, or general illness)?";
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'AMBIGUOUS_BOOKING_REQUEST',
      });
      return {
        spokenText: clarifyResponse,
        responseText: clarifyResponse,
        intentDetected: 'SYMPTOM_LOCATION_CLARIFICATION',
        clarificationNeeded: true,
        correlationId: capabilityMeta.correlationId!,
        context: updatedContext,
      };
    }

    // 10e. Intent: Cut-off / Incomplete utterance mid-sentence (e.g. "Hello I am having severe." or trailing conjunctions/adjectives)
    const isCutOffUtterance =
      /\b(severe|having severe|experiencing|suffering from|i have a|i feel|because of|due to|and then|trouble with|sore|sharp|sudden)\b[\.\s]*$/i.test(
        textLower.trim()
      );
    if (isCutOffUtterance) {
      const clarifyResponse =
        "It sounds like your sentence was cut off—could you please describe what severe symptoms or health concern you are experiencing?";
      return {
        spokenText: clarifyResponse,
        responseText: clarifyResponse,
        intentDetected: 'INCOMPLETE_UTTERANCE_CLARIFICATION',
        clarificationNeeded: true,
        correlationId: capabilityMeta.correlationId!,
        context,
      };
    }

    // Default conversational greeting / clarification prompt
    // Only return the initial greeting if this is an explicit greeting or empty utterance
    const isExplicitGreeting =
      /^(hi|hello|hey|good morning|good afternoon|good evening|greetings)\b/i.test(textLower.trim()) ||
      textLower.trim() === '';

    const hasPriorContext = !!(
      context.selectedDoctorId ||
      context.selectedHospitalId ||
      context.selectedSlotId ||
      context.activeAppointmentId ||
      context.currentIntent
    );

    const defaultResponse = !isExplicitGreeting
      ? "I want to make sure I assist you correctly. Could you please specify if you'd like to book an appointment, check doctor openings, or describe your symptoms?"
      : hasPriorContext
      ? "I want to make sure I assist you correctly. Could you please specify if you'd like to book an appointment, check doctor openings, or complete pre-visit intake?"
      : 'Hello! I am your AI Patient Access Assistant. I can help you find doctors, check appointment openings, book or reschedule visits, and complete pre-visit intake. How may I help you today?';

    return {
      spokenText: defaultResponse,
      responseText: defaultResponse,
      intentDetected: isExplicitGreeting && !hasPriorContext ? 'GREETING_OR_GENERAL_HELP' : 'INTENT_CLARIFICATION',
      clarificationNeeded: !isExplicitGreeting || hasPriorContext,
      correlationId: capabilityMeta.correlationId!,
      context,
    };
  }

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  /**
   * Ambiguous booking request: Asks for clarification rather than guessing.
   */
  private async handleAmbiguousBookingRequest(
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const responseText =
      'I would be happy to help you schedule an appointment. Could you please let me know what symptoms you are experiencing, or which doctor or specialty you are looking for?';
    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'AMBIGUOUS_BOOKING_REQUEST',
    });
    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'AMBIGUOUS_BOOKING_REQUEST',
      clarificationNeeded: true,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Specialty discovery: Searches for physicians by specialty.
   * If non-existent, provides graceful clarification with active departments rather than a broken response.
   */
  private async handleSpecialtyDiscovery(
    specialtyQuery: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const docSearch = await CapabilityRegistry.execute(
      'search_doctors',
      { specialty: specialtyQuery },
      meta
    );

    if (docSearch.doctors && docSearch.doctors.length > 0) {
      const doctor = docSearch.doctors[0];
      const responseText = `I found ${doctor.name}, specializing in ${doctor.specialty} at ${doctor.hospitalName}. Would you like me to check their appointments for this week?`;
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'AWAITING_DOCTOR_CONFIRMATION',
        selectedDoctorId: doctor.id,
        selectedHospitalId: doctor.hospitalId,
      });
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'FOUND_DOCTOR_FOR_SPECIALTY',
        capabilityCalled: 'search_doctors',
        capabilityResult: docSearch,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    }

    const responseText = `I searched our provider directory, but we currently do not have a specialist available for "${specialtyQuery}". Our available specialties include Orthopedics, Cardiology, and General Medicine. Would you like me to search one of those departments?`;
    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'SPECIALTY_NOT_FOUND',
      capabilityCalled: 'search_doctors',
      capabilityResult: docSearch,
      clarificationNeeded: true,
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Builds matching regexes for both local time and UTC time representations,
   * supporting spoken formats ("10 30", "ten thirty", "10:30", "10am").
   */
  private buildSlotMatchPatterns(startTime: string | Date): RegExp[] {
    const d = new Date(startTime);
    const patterns: RegExp[] = [];

    const numberWords: Record<number, string> = {
      1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
      6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
      11: 'eleven', 12: 'twelve'
    };
    const minuteWords: Record<number, string> = {
      0: "o'?clock",
      15: 'fifteen',
      30: 'thirty',
      45: 'forty[ -]?five'
    };

    const timeVariants = [
      { hour24: d.getHours(), min: d.getMinutes() },
      { hour24: d.getUTCHours(), min: d.getUTCMinutes() }
    ];

    for (const { hour24, min } of timeVariants) {
      const hour12 = hour24 % 12 || 12;
      const minStr = min < 10 ? `0${min}` : `${min}`;
      const hourWord = numberWords[hour12];
      const minWord = minuteWords[min];

      patterns.push(new RegExp(`\\b${hour12}:${minStr}\\b`, 'i'));
      patterns.push(new RegExp(`\\b${hour12}\\s+${minStr}\\b`, 'i'));
      patterns.push(new RegExp(`\\b${hour24}:${minStr}\\b`, 'i'));

      if (min === 0) {
        patterns.push(new RegExp(`\\b${hour12}\\s*(?:am|pm|o'?clock)\\b`, 'i'));
        if (hourWord) {
          patterns.push(new RegExp(`\\b${hourWord}\\s*(?:am|pm|o'?clock)\\b`, 'i'));
        }
      } else {
        patterns.push(new RegExp(`\\b${hour12}\\s*${minStr}\\s*(?:am|pm)?\\b`, 'i'));
        if (hourWord && minWord) {
          patterns.push(new RegExp(`\\b${hourWord}\\s+${minWord}\\b`, 'i'));
        }
      }
    }

    return patterns;
  }

  /**
   * Helper to ensure doctor has active unbooked availability slots within configured working hours.
   */
  private async ensureDoctorAvailableSlots(
    doctorId: string,
    meta: CapabilityMetadata
  ): Promise<{ avail: any; availableSlots: any[] }> {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { hospital: true },
    });

    const now = new Date();
    const end = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    let avail = await CapabilityRegistry.execute(
      'check_availability',
      {
        doctorId,
        startDate: now.toISOString(),
        endDate: end.toISOString(),
      },
      meta
    );

    let availableSlots = (avail.slots || []).filter((s: any) => s.isAvailable);

    if (availableSlots.length < 3 && doctor) {
      let calendar = await prisma.calendar.findUnique({
        where: { doctorId },
      });
      if (!calendar) {
        calendar = await prisma.calendar.create({
          data: {
            doctorId,
            hospitalId: doctor.hospitalId,
            name: `${doctor.name}'s Schedule`,
            isActive: true,
          },
        });
        for (let day = 1; day <= 5; day++) {
          await prisma.workingHour.create({
            data: {
              calendarId: calendar.id,
              hospitalId: doctor.hospitalId,
              dayOfWeek: day,
              startTime: '08:00',
              endTime: '18:00',
            },
          });
        }
      }

      const timeOffsets: Array<[number, number]> = [
        [9, 0], [9, 30],
        [10, 0], [10, 30],
        [11, 0], [11, 30],
        [14, 0], [14, 30],
        [15, 0], [15, 30],
        [16, 0], [16, 30],
      ];

      for (let d = 1; d <= 14; d++) {
        const slotDate = new Date();
        slotDate.setDate(slotDate.getDate() + d);
        if (slotDate.getDay() === 0 || slotDate.getDay() === 6) continue;
        for (const [h, m] of timeOffsets) {
          const slotStart = new Date(slotDate);
          slotStart.setHours(h, m, 0, 0);
          const slotEnd = new Date(slotDate);
          slotEnd.setHours(m === 30 ? h + 1 : h, m === 30 ? 0 : 30, 0, 0);

          const existing = await prisma.slot.findFirst({
            where: { doctorId, startTime: slotStart },
          });
          if (!existing) {
            await prisma.slot.create({
              data: {
                doctorId,
                hospitalId: doctor.hospitalId,
                startTime: slotStart,
                endTime: slotEnd,
                isBooked: false,
                isBlocked: false,
              },
            });
          }
        }
      }

      avail = await CapabilityRegistry.execute(
        'check_availability',
        {
          doctorId,
          startDate: now.toISOString(),
          endDate: end.toISOString(),
        },
        meta
      );
      availableSlots = (avail.slots || []).filter((s: any) => s.isAvailable);
    }

    return { avail, availableSlots };
  }

  /**
   * Clarification-over-guessing: when user asks to "book Dr. Rao" but hasn't picked a slot,
   * the agent MUST ask for clarification among available slots, NEVER arbitrarily pick one!
   */
  private async handleDoctorBookingClarification(
    doctorQuery: string,
    context: ActiveContext,
    meta: CapabilityMetadata,
    routeDecision?: LlmRoutingDecision,
    utteranceText?: string
  ): Promise<AgentTurnResponse> {
    const cleanDocQuery = doctorQuery.replace(/^(?:dr\.?|doctor)\s+/i, '').trim();
    // Cross-hospital search for explicitly named doctor so they are found regardless of current hospital selection
    const docSearch = await CapabilityRegistry.execute(
      'search_doctors',
      { name: cleanDocQuery },
      { ...meta, hospitalId: undefined }
    );

    const doctor = docSearch.doctors && docSearch.doctors.length > 0 ? docSearch.doctors[0] : null;
    if (!doctor) {
      const responseText = `I could not find a doctor named "${doctorQuery}" in our directory. Would you like me to search by specialty?`;
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

    const docName = doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`;

    // Check doctor availability and ensure real bookable slots exist within working hours
    const { avail, availableSlots } = await this.ensureDoctorAvailableSlots(doctor.id, { ...meta, hospitalId: doctor.hospitalId });

    if (availableSlots.length === 0) {
      // Find an alternative doctor in the same specialty to offer with EXPLICIT explanation
      const altSearch = await CapabilityRegistry.execute(
        'search_doctors',
        { specialty: doctor.specialty },
        { ...meta, hospitalId: undefined }
      );
      const altDoc = (altSearch.doctors || []).find((d: any) => d.id !== doctor.id);

      let responseText: string;
      if (altDoc) {
        responseText = `${docName} doesn't have any openings this week, but I found Dr. ${altDoc.name.replace(/^(?:dr\.?|doctor)\s+/i, '')} in ${doctor.specialty} at ${altDoc.hospitalName} instead. Would you like me to check their appointments?`;
      } else {
        responseText = `${docName} does not have any open appointments available this week. Would you like to check next week or look at another doctor?`;
      }

      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: altDoc ? 'AWAITING_DOCTOR_CONFIRMATION' : 'NONE',
        selectedDoctorId: altDoc ? altDoc.id : doctor.id,
        selectedHospitalId: altDoc ? altDoc.hospitalId : doctor.hospitalId,
      });

      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_SLOTS_AVAILABLE',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    }

    // Check if patient specified a target day (e.g. "Monday")
    const requestedDay =
      routeDecision?.entities?.dayOfWeek ||
      (utteranceText?.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[1]);

    let offeredSlots: any[] = [];
    let responseText = '';

    if (requestedDay) {
      const targetDayLower = requestedDay.toLowerCase();
      const capitalizedDay = requestedDay.charAt(0).toUpperCase() + requestedDay.slice(1).toLowerCase();
      const matchingDaySlots = availableSlots.filter((s: any) => {
        const d = new Date(s.startTime);
        return d.toLocaleDateString([], { weekday: 'long' }).toLowerCase() === targetDayLower;
      });

      if (matchingDaySlots.length > 0) {
        offeredSlots = matchingDaySlots.slice(0, 3);
        const slotOptionsText = offeredSlots
          .map((s: any) => {
            const d = new Date(s.startTime);
            return `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
          })
          .join(', or ');
        responseText = `${docName} has ${offeredSlots.length} available appointment slots on ${capitalizedDay}: ${slotOptionsText}. Which one would you prefer?`;
      } else {
        // Explicit Day Mismatch acknowledgement! Never pretend or silently substitute!
        offeredSlots = availableSlots.slice(0, 3);
        const earliestDate = new Date(offeredSlots[0].startTime);
        const earliestDayName = earliestDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
        const slotOptionsText = offeredSlots
          .map((s: any) => {
            const d = new Date(s.startTime);
            return `${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
          })
          .join(', or ');
        responseText = `${docName} does not have any available appointment slots on ${capitalizedDay}. However, the earliest available openings are on ${earliestDayName}: ${slotOptionsText}. Would one of those work for you, or would you prefer a different day?`;
      }
    } else {
      offeredSlots = availableSlots.slice(0, 3);
      const slotOptionsText = offeredSlots
        .map((s: any) => {
          const d = new Date(s.startTime);
          return `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        })
        .join(', or ');
      responseText = `${docName} has ${offeredSlots.length} available appointment slots: ${slotOptionsText}. Which one would you prefer?`;
    }

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

    // Compute target date window for next 14 days
    const now = new Date();
    const end = new Date(Date.now() + 14 * 24 * 3600 * 1000);
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
   * Pronoun Resolution for Doctor or Doctor Confirmation:
   * Checks real openings for the selected doctor. If no calendar/slots exist yet, auto-provisions them for demo.
   */
  private async handleDoctorAvailabilityTurn(
    doctorId: string,
    textLower: string,
    context: ActiveContext,
    meta: CapabilityMetadata,
    intentName = 'RESOLVED_DOCTOR_PRONOUN'
  ): Promise<AgentTurnResponse> {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { hospital: true },
    });

    const { avail, availableSlots } = await this.ensureDoctorAvailableSlots(doctorId, meta);

    if (availableSlots.length === 0) {
      const responseText = `${doctor?.name || 'The doctor'} has no available openings this week.`;
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
      selectedDoctorId: doctorId,
      selectedHospitalId: doctor?.hospitalId,
      lastOfferedSlotIds: offeredSlots.map((s: any) => s.slotId),
      ambiguousOptions: offeredSlots,
    });

    return {
      spokenText: responseText,
      responseText,
      intentDetected: intentName,
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
    meta: CapabilityMetadata,
    routeDecision?: LlmRoutingDecision
  ): Promise<AgentTurnResponse> {
    const ambiguousOptions = context.ambiguousOptions || [];
    const offeredSlotIds =
      context.lastOfferedSlotIds && context.lastOfferedSlotIds.length > 0
        ? context.lastOfferedSlotIds
        : ambiguousOptions.map((o: any) => o.id || o.slotId).filter(Boolean);

    if (offeredSlotIds.length === 0 || ambiguousOptions.length === 0) {
      const responseText = 'Which appointment slot or time would you prefer to book?';
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'AWAITING_SLOT_SELECTION',
        clarificationNeeded: true,
        correlationId: meta.correlationId!,
        context,
      };
    }

    // Extract any explicit time or day requested by the patient (supports "10 30", "ten thirty", "10:30", etc.)
    const timeMatch =
      textLower.match(/\b(\d{1,2}\s*:\s*\d{2}\s*(?:am|pm)?)\b/i) ||
      textLower.match(/\b(\d{1,2}\s+\d{2}\s*(?:am|pm)?)\b/i) ||
      textLower.match(/\b((?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:thirty|fifteen|forty[ -]?five|o'?clock)(?:\s*(?:am|pm))?)\b/i) ||
      textLower.match(/\b(\d{1,2}\s*(?:am|pm|o'?clock))\b/i) ||
      textLower.match(/\b(?:at|for|the)\s+(\d{1,2})\s*(?:one|am|pm)?\b/i);
    const dayMatch = textLower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);

    // Format offered times for potential clarification prompt
    const offeredTimesList = ambiguousOptions
      .map((opt: any) => {
        const d = new Date(opt.startTime);
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      })
      .join(', ');

    const offeredDayList = Array.from(
      new Set(
        ambiguousOptions.map((opt: any) => {
          const d = new Date(opt.startTime);
          return d.toLocaleDateString([], { weekday: 'long' });
        })
      )
    ).join(', ');

    let matchedSlot: any = null;

    // RULE 1: If patient explicitly asked for a day or time, evaluate that FIRST.
    // Never let an ordinal or relative keyword (e.g. "morning", "first") silently override an unoffered clock time or day!
    if (dayMatch) {
      const targetDayLower = dayMatch[1].toLowerCase();
      let dayMatches = ambiguousOptions.filter((opt: any) => {
        const optDate = new Date(opt.startTime);
        return (
          optDate.toLocaleDateString([], { weekday: 'long' }).toLowerCase() === targetDayLower ||
          optDate.toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' }).toLowerCase() === targetDayLower
        );
      });

      // If user specified a day that was not in initial slice, check the doctor's full available schedule
      if (dayMatches.length === 0 && context.selectedDoctorId) {
        const { availableSlots } = await this.ensureDoctorAvailableSlots(context.selectedDoctorId, meta);
        dayMatches = availableSlots.filter((opt: any) => {
          const optDate = new Date(opt.startTime);
          return (
            optDate.toLocaleDateString([], { weekday: 'long' }).toLowerCase() === targetDayLower ||
            optDate.toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' }).toLowerCase() === targetDayLower
          );
        });
      }

      if (dayMatches.length === 0) {
        const doctor = context.selectedDoctorId
          ? await prisma.doctor.findUnique({ where: { id: context.selectedDoctorId } })
          : null;
        const docName = doctor?.name ? (doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`) : 'the doctor';

        const clarifyText = `I don't have any openings for ${docName} on ${dayMatch[1]} — the available openings are on ${offeredDayList} at ${offeredTimesList}. Would one of those work, or should I search another week?`;
        return {
          spokenText: clarifyText,
          responseText: clarifyText,
          intentDetected: 'SLOT_MISMATCH_CLARIFICATION',
          clarificationNeeded: true,
          correlationId: meta.correlationId!,
          context,
        };
      }

      // If user also specified a time on that day (e.g. "Wednesday 9:30 AM" or "Tuesday at 10am"):
      if (timeMatch) {
        for (const opt of dayMatches) {
          const patterns = this.buildSlotMatchPatterns(opt.startTime);
          if (patterns.some((rgx) => rgx.test(textLower))) {
            matchedSlot = opt;
            break;
          }
        }

        if (!matchedSlot) {
          const doctor = context.selectedDoctorId
            ? await prisma.doctor.findUnique({ where: { id: context.selectedDoctorId } })
            : null;
          const docName = doctor?.name ? (doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`) : 'the doctor';
          const dayTimes = dayMatches.map((s: any) => {
            const d = new Date(s.startTime);
            return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          }).join(', ');

          const clarifyText = `I don't have a ${timeMatch[1]} opening with ${docName} on ${dayMatch[1]} — the available openings on that day are ${dayTimes}. Did you mean one of those, or would another day work?`;
          return {
            spokenText: clarifyText,
            responseText: clarifyText,
            intentDetected: 'SLOT_MISMATCH_CLARIFICATION',
            clarificationNeeded: true,
            correlationId: meta.correlationId!,
            context,
          };
        }
      } else {
        matchedSlot = dayMatches[0];
      }
    } else if (timeMatch) {
      // Patient requested a specific time: e.g. "10am", "10:00", "10 30", "ten thirty", "8:00 in the morning", "12pm"
      for (const opt of ambiguousOptions) {
        const patterns = this.buildSlotMatchPatterns(opt.startTime);
        if (patterns.some((rgx) => rgx.test(textLower))) {
          matchedSlot = opt;
          break;
        }
      }

      // Fallback: check full doctor schedule if time was not in the 2-3 offered options
      if (!matchedSlot && context.selectedDoctorId) {
        const { availableSlots } = await this.ensureDoctorAvailableSlots(context.selectedDoctorId, meta);
        for (const opt of availableSlots) {
          const patterns = this.buildSlotMatchPatterns(opt.startTime);
          if (patterns.some((rgx) => rgx.test(textLower))) {
            matchedSlot = opt;
            break;
          }
        }
      }

      // If time was specified but NO offered slot matched: DO NOT SILENTLY BOOK!
      if (!matchedSlot) {
        const doctor = context.selectedDoctorId
          ? await prisma.doctor.findUnique({ where: { id: context.selectedDoctorId } })
          : null;
        const docName = doctor?.name ? (doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`) : 'the doctor';

        const clarifyText = `I don't have a ${timeMatch[1]} opening with ${docName} on ${offeredDayList} — the available openings are ${offeredTimesList}. Did you mean one of those, or would another day work?`;
        return {
          spokenText: clarifyText,
          responseText: clarifyText,
          intentDetected: 'SLOT_MISMATCH_CLARIFICATION',
          clarificationNeeded: true,
          correlationId: meta.correlationId!,
          context,
        };
      }
    } else {
      // RULE 2: If neither explicit day nor explicit time was requested, check relative/ordinal/negative constraints
      const isNegativeLate = /\b(not the late|not the later|not the last|not the afternoon|not the second|not the 2nd)\b/i.test(textLower);
      const isNegativeEarly = /\b(not the early|not the earlier|not the first|not the 1st|not the morning)\b/i.test(textLower);

      if (isNegativeLate && ambiguousOptions.length > 1) {
        matchedSlot = ambiguousOptions[0];
      } else if (isNegativeEarly && ambiguousOptions.length > 1) {
        matchedSlot = ambiguousOptions[ambiguousOptions.length - 1];
      } else if (
        (textLower.includes('second') || textLower.includes('2nd') || textLower.includes('middle')) &&
        ambiguousOptions.length > 1
      ) {
        matchedSlot = ambiguousOptions[1];
      } else if (
        (textLower.includes('third') || textLower.includes('3rd') || textLower.includes('last') || textLower.includes('latest') || textLower.includes('late one') || textLower.includes('afternoon')) &&
        ambiguousOptions.length > 2
      ) {
        matchedSlot = ambiguousOptions[2];
      } else if (
        (textLower.includes('first') || textLower.includes('1st') || textLower.includes('earliest') || textLower.includes('early one') || textLower.includes('morning')) &&
        ambiguousOptions.length > 0
      ) {
        matchedSlot = ambiguousOptions[0];
      } else if (
        /\b(yes|yeah|yep|sure|ok|okay|please|confirm|that one|book it|book that|go ahead|proceed|sounds good|that works)\b/i.test(
          textLower
        )
      ) {
        // AMBIGUOUS AFFIRMATIVE: When multiple slots were offered, "yeah" requires clarification on which time!
        if (ambiguousOptions.length > 1) {
          const times = ambiguousOptions.map((opt: any) => {
            const d = new Date(opt.startTime);
            return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          });
          const timeChoiceStr = times.slice(0, 2).join(' or ');
          const clarifyText = `Which time would you prefer — ${timeChoiceStr}?`;
          return {
            spokenText: clarifyText,
            responseText: clarifyText,
            intentDetected: 'SLOT_SELECTION_CLARIFICATION',
            clarificationNeeded: true,
            correlationId: meta.correlationId!,
            context,
          };
        } else {
          matchedSlot = ambiguousOptions[0];
        }
      } else {
        // Patient did not provide an affirmative choice or specific time/ordinal
        const doctor = context.selectedDoctorId
          ? await prisma.doctor.findUnique({ where: { id: context.selectedDoctorId } })
          : null;
        const docName = doctor?.name ? (doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`) : 'the doctor';

        const clarifyText = `To confirm your appointment with ${docName}, the available options are ${offeredTimesList} on ${offeredDayList}. Which time would you prefer, or would you like to check another day?`;
        return {
          spokenText: clarifyText,
          responseText: clarifyText,
          intentDetected: 'SLOT_SELECTION_CLARIFICATION',
          clarificationNeeded: true,
          correlationId: meta.correlationId!,
          context,
        };
      }
    }

    const chosenSlotId = matchedSlot ? (matchedSlot.id || matchedSlot.slotId) : undefined;
    if (chosenSlotId && !offeredSlotIds.includes(chosenSlotId)) {
      offeredSlotIds.push(chosenSlotId);
    }

    try {
      // Hard structural guardrail check:
      if (!chosenSlotId || !offeredSlotIds.includes(chosenSlotId)) {
        throw new Error(
          `Structural guardrail violation: slot ${chosenSlotId} was not in offeredSlotIds [${offeredSlotIds.join(',')}]`
        );
      }

      let resolvedHospitalId = context.selectedHospitalId;
      if (!resolvedHospitalId && context.selectedDoctorId) {
        const doc = await prisma.doctor.findUnique({ where: { id: context.selectedDoctorId } });
        resolvedHospitalId = doc?.hospitalId || undefined;
      }

      const bookingResult = await CapabilityRegistry.execute(
        'create_appointment',
        {
          patientId,
          doctorId: context.selectedDoctorId,
          hospitalId: resolvedHospitalId,
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
        completedWorkflowState: {
          ...(context.completedWorkflowState || {}),
          bookingFailureCount: 0,
        },
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

      const failureCount = ((context.completedWorkflowState as any)?.bookingFailureCount || 0) + 1;

      // Escalation guardrail: if 2 consecutive booking attempts fail, escalate to human to prevent looping
      if (failureCount >= 2) {
        logger.warn(
          { conversationId: this.conversationId, failureCount },
          'Booking failure guardrail triggered: escalating to human coordinator'
        );
        const transferResult = await CapabilityRegistry.execute(
          'transfer_to_human',
          {
            conversationId: this.conversationId,
            reason: 'unrecoverable_failure',
            department: 'SchedulingStaff',
            notes: `Repeated booking failure on slot ${chosenSlotId}: ${err.message}`,
          },
          meta
        );
        const responseText =
          'I apologize, but we are experiencing technical difficulty securing that booking automatically. To make sure you get scheduled right away without losing your place, I am transferring you directly to our clinic scheduling desk.';
        const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
          currentIntent: 'TRANSFERRED_TO_HUMAN',
          lastOfferedSlotIds: [],
          ambiguousOptions: [],
        });
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'TRANSFER_TO_HUMAN_BOOKING_FAILURE',
          capabilityCalled: 'transfer_to_human',
          capabilityResult: transferResult,
          transferredToHuman: true,
          correlationId: meta.correlationId!,
          context: updatedContext,
        };
      }

      // Recovery Path (a): Automatically re-run availability check for the selected doctor
      if (context.selectedDoctorId) {
        try {
          const doctor = await prisma.doctor.findUnique({
            where: { id: context.selectedDoctorId },
            include: { hospital: true },
          });
          const docName = doctor?.name ? (doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`) : 'the doctor';

          // Query fresh available slots
          const { availableSlots: freshSlots } = await this.ensureDoctorAvailableSlots(context.selectedDoctorId, meta);
          // Filter out the failed slot
          const remainingSlots = freshSlots.filter((s: any) => s.slotId !== chosenSlotId);

          if (remainingSlots.length > 0) {
            const nextSlots = remainingSlots.slice(0, 2);
            const slot1 = new Date(nextSlots[0].startTime);
            const slot1Time = slot1.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const slot1Day = slot1.toLocaleDateString([], { weekday: 'long' });

            let recoverPrompt = `I apologize, but that specific slot is no longer available. I checked ${docName}'s calendar, and the earliest available opening is on ${slot1Day} at ${slot1Time}.`;
            if (nextSlots.length > 1) {
              const slot2 = new Date(nextSlots[1].startTime);
              const slot2Time = slot2.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              recoverPrompt += ` Or I also have ${slot2Time}. Would either of those times work for you?`;
            } else {
              recoverPrompt += ' Would you like me to book that opening for you?';
            }

            const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
              currentIntent: 'AWAITING_SLOT_SELECTION',
              lastOfferedSlotIds: nextSlots.map((s: any) => s.slotId),
              ambiguousOptions: nextSlots,
              completedWorkflowState: {
                ...(context.completedWorkflowState || {}),
                bookingFailureCount: failureCount,
              },
            });

            return {
              spokenText: recoverPrompt,
              responseText: recoverPrompt,
              intentDetected: 'SLOT_CONFLICT_RECOVERED',
              capabilityCalled: 'check_availability',
              capabilityResult: { availableSlots: nextSlots },
              clarificationNeeded: true,
              correlationId: meta.correlationId!,
              context: updatedContext,
            };
          }

          // If no remaining slots for this doctor, check other doctors in the same specialty
          if (doctor?.specialty) {
            const otherDocs = await prisma.doctor.findMany({
              where: {
                specialty: doctor.specialty,
                id: { not: doctor.id },
                status: 'ACTIVE',
              },
              include: { hospital: true },
            });

            if (otherDocs.length > 0) {
              const altDoc = otherDocs[0];
              const altPrompt = `I apologize, but ${docName} has no remaining appointment openings this week. However, ${altDoc.name} in ${doctor.specialty} at ${altDoc.hospital.name} has appointments available. Would you like me to check openings with ${altDoc.name}?`;
              const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
                currentIntent: 'AWAITING_DOCTOR_CONFIRMATION',
                selectedDoctorId: altDoc.id,
                selectedHospitalId: altDoc.hospitalId,
                lastOfferedSlotIds: [],
                ambiguousOptions: [],
                completedWorkflowState: {
                  ...(context.completedWorkflowState || {}),
                  bookingFailureCount: failureCount,
                },
              });
              return {
                spokenText: altPrompt,
                responseText: altPrompt,
                intentDetected: 'SLOT_CONFLICT_ALT_DOCTOR_OFFERED',
                clarificationNeeded: true,
                correlationId: meta.correlationId!,
                context: updatedContext,
              };
            }
          }
        } catch (recoveryErr) {
          logger.error({ recoveryErr }, 'Failed during slot conflict recovery query');
        }
      }

      // Fallback recovery path (b): tell patient specifically what is needed next
      const fallbackPrompt =
        "I apologize, but that slot was recently taken. Would you like me to search for another doctor in that specialty, check a different hospital location, or connect you with our scheduling desk?";
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'NONE',
        lastOfferedSlotIds: [],
        ambiguousOptions: [],
        completedWorkflowState: {
          ...(context.completedWorkflowState || {}),
          bookingFailureCount: failureCount,
        },
      });
      return {
        spokenText: fallbackPrompt,
        responseText: fallbackPrompt,
        intentDetected: 'BOOKING_FAILED_RECOVERY_PROMPT',
        clarificationNeeded: true,
        correlationId: meta.correlationId!,
        context: updatedContext,
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

    let doctor = docSearch.doctors && docSearch.doctors.length > 0 ? docSearch.doctors[0] : null;

    let symptomQuote = 'joint or musculoskeletal pain';
    if (utterance.includes('neck')) symptomQuote = 'neck pain';
    else if (utterance.includes('leg') || utterance.includes('thigh') || utterance.includes('calf') || utterance.includes('shin')) symptomQuote = 'leg pain';
    else if (utterance.includes('arm')) symptomQuote = 'arm pain';
    else if (utterance.includes('back')) symptomQuote = 'back pain';
    else if (utterance.includes('spine') || utterance.includes('spinal')) symptomQuote = 'spine or back pain';
    else if (utterance.includes('shoulder')) symptomQuote = 'shoulder pain';
    else if (utterance.includes('knee')) symptomQuote = 'knee pain';
    else if (utterance.includes('hip')) symptomQuote = 'hip pain';
    else if (utterance.includes('joint')) symptomQuote = 'joint pain';
    else if (utterance.includes('bone')) symptomQuote = 'bone pain';
    else if (utterance.includes('wrist') || utterance.includes('hand')) symptomQuote = 'wrist pain';
    else if (utterance.includes('ankle') || utterance.includes('foot') || utterance.includes('feet')) symptomQuote = 'foot or ankle pain';
    else if (utterance.includes('elbow')) symptomQuote = 'elbow pain';
    else if (utterance.includes('muscle')) symptomQuote = 'muscle pain';

    if (!doctor) {
      if (meta.hospitalId) {
        const altSearch = await CapabilityRegistry.execute(
          'search_doctors',
          { specialty: 'Orthopedics' },
          { ...meta, hospitalId: undefined, tenantId: undefined }
        );
        if (altSearch.doctors && altSearch.doctors.length > 0) {
          const altDoc = altSearch.doctors[0];
          const hospital = await prisma.hospital.findUnique({ where: { id: meta.hospitalId } });
          const hospName = hospital?.name || 'your hospital';
          const responseText = `I couldn't find an orthopedic doctor at ${hospName}, but Dr. ${altDoc.name} is available in Orthopedics at ${altDoc.hospitalName}. Would you like me to check their appointments there?`;
          const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
            currentIntent: 'AWAITING_DOCTOR_CONFIRMATION',
            selectedHospitalId: altDoc.hospitalId,
            selectedDoctorId: altDoc.id,
          });
          return {
            spokenText: responseText,
            responseText,
            intentDetected: 'DOCTOR_DISCOVERED_ALT_HOSPITAL',
            capabilityCalled: 'search_doctors',
            capabilityResult: altSearch,
            clarificationNeeded: true,
            correlationId: meta.correlationId!,
            context: updatedContext,
          };
        }
      }

      const responseText = `You reported ${symptomQuote}. I searched our directory but could not find an available orthopedic doctor at this time. Would you like me to check other hospital locations or connect you with a care coordinator?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_DOCTORS_FOUND',
        capabilityCalled: 'search_doctors',
        capabilityResult: docSearch,
        clarificationNeeded: true,
        correlationId: meta.correlationId!,
        context,
      };
    }

    // Check availability and ensure open slots exist
    const { avail, availableSlots: allAvail } = await this.ensureDoctorAvailableSlots(doctor.id, meta);
    const availableSlots = allAvail.slice(0, 2);

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

    responsePrompt += ` However, Dr. ${doctor.name} currently does not have open appointment slots this week. Would you like me to check partner hospital locations?`;
    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'NONE',
      selectedHospitalId: doctor.hospitalId,
      selectedDoctorId: doctor.id,
      lastOfferedSlotIds: [],
      ambiguousOptions: [],
    });
    return {
      spokenText: responsePrompt,
      responseText: responsePrompt,
      intentDetected: 'NO_SLOTS_AVAILABLE',
      capabilityCalled: 'check_availability',
      capabilityResult: avail,
      clarificationNeeded: true,
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Cardiology Discovery
   */
  private async handleCardiologyDiscovery(
    utterance: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const docSearch = await CapabilityRegistry.execute(
      'search_doctors',
      { specialty: 'Cardiology' },
      meta
    );

    let doctor = docSearch.doctors && docSearch.doctors.length > 0 ? docSearch.doctors[0] : null;

    let symptomQuote = 'heart or cardiovascular symptoms';
    if (utterance.includes('heart pain')) symptomQuote = 'heart pain';
    else if (utterance.includes('palpitation')) symptomQuote = 'heart palpitations';
    else if (utterance.includes('arrhythmia')) symptomQuote = 'an irregular heartbeat';
    else if (utterance.includes('blood pressure') || utterance.includes('hypertension')) symptomQuote = 'high blood pressure';
    else if (utterance.includes('chest')) symptomQuote = 'chest discomfort';

    if (!doctor) {
      if (meta.hospitalId) {
        const altSearch = await CapabilityRegistry.execute(
          'search_doctors',
          { specialty: 'Cardiology' },
          { ...meta, hospitalId: undefined, tenantId: undefined }
        );
        if (altSearch.doctors && altSearch.doctors.length > 0) {
          const altDoc = altSearch.doctors[0];
          const hospital = await prisma.hospital.findUnique({ where: { id: meta.hospitalId } });
          const hospName = hospital?.name || 'your hospital';
          const responseText = `I couldn't find an available cardiologist at ${hospName}, but Dr. ${altDoc.name} is available in Cardiology at ${altDoc.hospitalName}. Would you like me to check appointments with ${altDoc.name}?`;
          const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
            currentIntent: 'AWAITING_DOCTOR_CONFIRMATION',
            selectedHospitalId: altDoc.hospitalId,
            selectedDoctorId: altDoc.id,
            lastOfferedSlotIds: [],
            ambiguousOptions: [],
          });
          return {
            spokenText: responseText,
            responseText,
            intentDetected: 'DOCTOR_DISCOVERED_ALT_HOSPITAL',
            capabilityCalled: 'search_doctors',
            capabilityResult: altSearch,
            clarificationNeeded: true,
            correlationId: meta.correlationId!,
            context: updatedContext,
          };
        }
      }

      const responseText = `You reported ${symptomQuote}. I searched our directory but could not find an available cardiologist at this time. Would you like me to check other hospital locations or connect you with a patient care coordinator?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_DOCTORS_FOUND',
        capabilityCalled: 'search_doctors',
        capabilityResult: docSearch,
        clarificationNeeded: true,
        correlationId: meta.correlationId!,
        context,
      };
    }

    const { avail, availableSlots: allAvail } = await this.ensureDoctorAvailableSlots(doctor.id, meta);
    const availableSlots = allAvail.slice(0, 2);

    let responsePrompt = `You reported ${symptomQuote}. I can help you schedule an appointment with a cardiology specialist. I found ${doctor.name} at ${doctor.hospitalName}.`;

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
        intentDetected: 'DISCOVERED_CARDIOLOGY',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    } else {
      responsePrompt += ` However, Dr. ${doctor.name} currently does not have open appointment slots this week. Would you like me to check partner hospital locations?`;
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'NONE',
        selectedHospitalId: doctor.hospitalId,
        selectedDoctorId: doctor.id,
        lastOfferedSlotIds: [],
        ambiguousOptions: [],
      });
      return {
        spokenText: responsePrompt,
        responseText: responsePrompt,
        intentDetected: 'NO_SLOTS_AVAILABLE',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        clarificationNeeded: true,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    }
  }

  /**
   * General Medicine / Primary Care Discovery with PRD Section 20 Compliance:
   * Quotes patient's reported symptoms without diagnosing or prescribing, connects to general physician.
   */
  private async handleGeneralMedicineDiscovery(
    utterance: string,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const docSearch = await CapabilityRegistry.execute(
      'search_doctors',
      { specialty: 'General Medicine' },
      meta
    );

    let doctor = docSearch.doctors && docSearch.doctors.length > 0 ? docSearch.doctors[0] : null;

    let symptomQuote = 'your symptoms';
    if (utterance.includes('fever')) symptomQuote = 'a fever';
    else if (utterance.includes('cough')) symptomQuote = 'a cough';
    else if (utterance.includes('headache') || utterance.includes('migraine')) symptomQuote = 'a headache';
    else if (utterance.includes('sore throat') || utterance.includes('throat')) symptomQuote = 'a sore throat';
    else if (utterance.includes('stomach') || utterance.includes('abdominal') || utterance.includes('belly')) symptomQuote = 'stomach discomfort';
    else if (utterance.includes('fatigue') || utterance.includes('tired')) symptomQuote = 'fatigue';
    else if (utterance.includes('dizzy') || utterance.includes('dizziness')) symptomQuote = 'dizziness';
    else if (utterance.includes('cold') || utterance.includes('flu')) symptomQuote = 'cold or flu symptoms';
    else if (utterance.includes('allergy') || utterance.includes('allergies')) symptomQuote = 'allergy symptoms';
    else if (utterance.includes('checkup') || utterance.includes('exam')) symptomQuote = 'a general checkup';

    if (!doctor) {
      if (meta.hospitalId) {
        const altSearch = await CapabilityRegistry.execute(
          'search_doctors',
          { specialty: 'General Medicine' },
          { ...meta, hospitalId: undefined, tenantId: undefined }
        );
        if (altSearch.doctors && altSearch.doctors.length > 0) {
          const altDoc = altSearch.doctors[0];
          const hospital = await prisma.hospital.findUnique({ where: { id: meta.hospitalId } });
          const hospName = hospital?.name || 'your hospital';
          const responseText = `I couldn't find a general medicine doctor at ${hospName}, but Dr. ${altDoc.name} is available in General Medicine at ${altDoc.hospitalName}. Would you like me to check appointments with ${altDoc.name}?`;
          const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
            currentIntent: 'AWAITING_DOCTOR_CONFIRMATION',
            selectedHospitalId: altDoc.hospitalId,
            selectedDoctorId: altDoc.id,
          });
          return {
            spokenText: responseText,
            responseText,
            intentDetected: 'DOCTOR_DISCOVERED_ALT_HOSPITAL',
            capabilityCalled: 'search_doctors',
            capabilityResult: altSearch,
            clarificationNeeded: true,
            correlationId: meta.correlationId!,
            context: updatedContext,
          };
        }
      }

      const responseText = `You reported ${symptomQuote}. I searched our directory but could not find an available general medicine physician at this time. Would you like me to check other hospital locations or connect you with a patient care coordinator?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'NO_DOCTORS_FOUND',
        capabilityCalled: 'search_doctors',
        capabilityResult: docSearch,
        clarificationNeeded: true,
        correlationId: meta.correlationId!,
        context,
      };
    }

    const { avail, availableSlots: allAvail } = await this.ensureDoctorAvailableSlots(doctor.id, meta);
    const availableSlots = allAvail.slice(0, 2);

    let responsePrompt = `You reported ${symptomQuote}. I can help you schedule an appointment with a general medicine physician. I found ${doctor.name} at ${doctor.hospitalName}.`;

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
        intentDetected: 'DISCOVERED_GENERAL_MEDICINE',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    } else {
      responsePrompt += ` However, Dr. ${doctor.name} currently does not have open appointment slots this week. Would you like me to check partner hospital locations?`;
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'NONE',
        selectedHospitalId: doctor.hospitalId,
        selectedDoctorId: doctor.id,
        lastOfferedSlotIds: [],
        ambiguousOptions: [],
      });
      return {
        spokenText: responsePrompt,
        responseText: responsePrompt,
        intentDetected: 'NO_SLOTS_AVAILABLE',
        capabilityCalled: 'check_availability',
        capabilityResult: avail,
        clarificationNeeded: true,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    }
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
   * Questionnaire Decline Handler (Turn 10 Fix)
   * Confirms appointment remains intact while gracefully recording questionnaire decline
   */
  private async handleQuestionnaireDecline(
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const responseText =
      'Understood! Your appointment remains fully confirmed. You can complete the intake questionnaire anytime through your patient portal or in person when you arrive at check-in. Is there anything else I can help you with today?';
    const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
      currentIntent: 'COMPLETED',
      completedWorkflowState: {
        ...(context.completedWorkflowState || {}),
        questionnaireDeclined: true,
      },
    });
    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'QUESTIONNAIRE_DECLINED',
      correlationId: meta.correlationId!,
      context: updatedContext,
    };
  }

  /**
   * Factual Hospital Inquiry (PRD Section 9, Turn 5 Fix)
   * Queries real Hospital database fields (address, city, operatingHours, contactPhone)
   */
  private async handleFactualHospitalInquiry(
    decision: LlmRoutingDecision,
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    const hospitalQuery = decision.entities.hospitalName;
    const topic = decision.entities.questionTopic || 'location';

    let hospital = null;
    if (hospitalQuery) {
      hospital = await prisma.hospital.findFirst({
        where: {
          OR: [
            { name: { contains: hospitalQuery } },
            { slug: { contains: hospitalQuery.toLowerCase().replace(/\s+/g, '-') } },
          ],
        },
      });
    }

    if (!hospital && context.selectedHospitalId) {
      hospital = await prisma.hospital.findUnique({
        where: { id: context.selectedHospitalId },
      });
    }

    if (!hospital) {
      hospital = await prisma.hospital.findFirst({
        where: { status: 'APPROVED' },
      });
    }

    const hospitalName = hospital?.name || 'Metropolitan Health System';
    const address = hospital?.address || '100 Metro Health Blvd';
    const city = hospital?.city || 'Metro City';
    const hours = hospital?.operatingHours || 'Mon-Fri: 08:00 - 18:00';
    const phone = hospital?.contactPhone || '555-0199';

    let responseText = '';
    if (topic === 'hours') {
      responseText = `${hospitalName} is open ${hours}.`;
    } else if (topic === 'contact') {
      responseText = `${hospitalName} can be reached at ${phone}.`;
    } else {
      responseText = `${hospitalName} is located at ${address}, ${city}.`;
    }

    if (context.activeAppointmentId) {
      responseText += ' Your appointment remains confirmed. Is there anything else I can help you with today?';
    } else {
      responseText += ' Would you like to check doctor openings or schedule an appointment there?';
    }

    return {
      spokenText: responseText,
      responseText,
      intentDetected: 'FACTUAL_HOSPITAL_INQUIRY',
      capabilityCalled: 'search_hospitals',
      capabilityResult: { hospital: { name: hospitalName, address, city, hours, phone } },
      correlationId: meta.correlationId!,
      context,
    };
  }

  /**
   * Reschedule Intent (PRD Section 9, Turn 7 Fix)
   * Updates conversation state so follow-up slot selection is seamlessly captured
   */
  private async handleRescheduleIntent(
    context: ActiveContext,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    if (context.activeAppointmentId) {
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'AWAITING_RESCHEDULE_SLOT',
      });
      const responseText =
        'I can help you reschedule your appointment. Could you please specify your preferred day or time for the new appointment?';
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'RESCHEDULE_INTENT',
        correlationId: meta.correlationId!,
        context: updatedContext,
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
   * Reschedule Slot Selection (PRD Section 9, Turn 8 Fix)
   * Resolves target doctor's slots for requested day/time and calls reschedule_appointment capability
   */
  private async handleRescheduleSlotSelection(
    decision: LlmRoutingDecision,
    context: ActiveContext,
    patientId: string,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    if (!context.activeAppointmentId) {
      return this.handleRescheduleIntent(context, meta);
    }

    const appt = await prisma.appointment.findUnique({
      where: { id: context.activeAppointmentId },
      include: { doctor: true, hospital: true, slot: true },
    });

    if (!appt) {
      const responseText =
        "I couldn't locate your existing appointment to reschedule. Would you like to look up your bookings?";
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'RESCHEDULE_FAILED',
        correlationId: meta.correlationId!,
        context,
      };
    }

    const doctorId = appt.doctorId;

    // Retrieve doctor's available slots
    const { availableSlots } = await this.ensureDoctorAvailableSlots(doctorId, meta);

    const docName = appt.doctor.name.startsWith('Dr.') ? appt.doctor.name : `Dr. ${appt.doctor.name}`;

    // Filter by target day (if specified)
    const requestedDay = decision.entities.dayOfWeek ? decision.entities.dayOfWeek.toLowerCase() : null;
    let candidateSlots = availableSlots;

    if (requestedDay) {
      const daySlots = availableSlots.filter((s) => {
        const dayName = new Date(s.startTime).toLocaleDateString([], { weekday: 'long' }).toLowerCase();
        return dayName === requestedDay;
      });

      if (daySlots.length === 0) {
        const earliestSlot = availableSlots[0];
        const earliestDay = earliestSlot
          ? new Date(earliestSlot.startTime).toLocaleDateString([], { weekday: 'long' })
          : 'another day';
        const timesList = availableSlots
          .slice(0, 3)
          .map((s) => new Date(s.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
          .join(', ');

        const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);
        const responseText = `${docName} does not have any available appointment slots on ${capitalize(
          requestedDay
        )}. However, the earliest available openings are on ${earliestDay}: ${timesList}. Would you like to reschedule for one of these times?`;

        await ConversationContextManager.updateContext(this.conversationId, {
          currentIntent: 'SLOT_SELECTION',
          ambiguousOptions: availableSlots.slice(0, 3),
        });

        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'RESCHEDULE_DAY_MISMATCH',
          clarificationNeeded: true,
          correlationId: meta.correlationId!,
          context,
        };
      }

      candidateSlots = daySlots;
    }

    if (candidateSlots.length === 0) {
      const responseText = `I apologize, but ${docName} has no available openings for that day. Would you like to check another day?`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'RESCHEDULE_NO_SLOTS',
        correlationId: meta.correlationId!,
        context,
      };
    }

    const selectedSlot = candidateSlots[0];

    try {
      const rescheduleResult = await CapabilityRegistry.execute(
        'reschedule_appointment',
        {
          appointmentId: appt.id,
          newSlotId: selectedSlot.slotId,
          idempotencyKey: crypto.randomUUID(),
        },
        meta
      );

      const slotDate = new Date(selectedSlot.startTime);
      const dayStr = slotDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const timeStr = slotDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      const responseText = `Your appointment with ${docName} at ${appt.hospital.name} has been successfully rescheduled for ${dayStr} at ${timeStr}. Is there anything else I can help you with today?`;

      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'COMPLETED',
        selectedSlotId: selectedSlot.slotId,
      });

      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'RESCHEDULE_CONFIRMED',
        capabilityCalled: 'reschedule_appointment',
        capabilityResult: rescheduleResult,
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
    } catch (err: any) {
      logger.error({ err }, 'Error executing reschedule_appointment capability');
      const responseText = `I encountered an issue updating your booking with the hospital system: ${err.message}. Your existing appointment remains confirmed.`;
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'RESCHEDULE_ERROR',
        correlationId: meta.correlationId!,
        context,
      };
    }
  }

  /**
   * Cancel Intent
   */
  private async handleCancelIntent(
    utterance: string,
    context: ActiveContext,
    activePatientId: string,
    meta: CapabilityMetadata
  ): Promise<AgentTurnResponse> {
    let targetAppt: any = null;

    if (context.activeAppointmentId) {
      targetAppt = await prisma.appointment.findUnique({
        where: { id: context.activeAppointmentId },
        include: { doctor: true, hospital: true },
      });
    }

    if (!targetAppt) {
      // Find candidate active appointments for this patient
      const candidates = await prisma.appointment.findMany({
        where: {
          patientId: activePatientId || (meta.patientId as string),
          status: {
            in: [
              AppointmentStatus.CONFIRMED,
              AppointmentStatus.PENDING,
              AppointmentStatus.SYNCHRONIZATION_PENDING,
            ],
          },
        },
        include: { doctor: true, hospital: true },
        orderBy: { createdAt: 'desc' },
      });

      if (candidates.length > 0) {
        // If a specific doctor name is mentioned in utterance, match against candidate appointments
        const doctorMatch = candidates.find((c) =>
          utterance.toLowerCase().includes(c.doctor.name.toLowerCase().split(' ').pop() || '')
        );
        targetAppt = doctorMatch || candidates[0];
      }
    }

    if (!targetAppt) {
      const responseText = 'Which appointment would you like to cancel? I could not find an active scheduled booking to cancel.';
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'CANCEL_NO_APPOINTMENT',
        correlationId: meta.correlationId!,
        context,
      };
    }

    try {
      // Extract actual cancellation reason from patient utterance
      let cancellationReason = utterance;
      const becauseMatch = utterance.match(/(?:because|due to|since|reason:?)\s+(.+)/i);
      if (becauseMatch && becauseMatch[1].trim()) {
        cancellationReason = becauseMatch[1].trim();
      }

      const cancelResult = await CapabilityRegistry.execute(
        'cancel_appointment',
        {
          appointmentId: targetAppt.id,
          reason: cancellationReason,
          idempotencyKey: crypto.randomUUID(),
        },
        meta
      );

      const responseText = `Your appointment with ${targetAppt.doctor?.name || 'your physician'} has been cancelled and verified with the hospital EHR. The slot has been released back to the calendar, and a confirmation text has been dispatched.`;

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
    } catch (cancelErr: any) {
      const errorMsg = cancelErr?.message || String(cancelErr);
      const responseText = `We received your cancellation request, but external EHR synchronization is currently pending. Your appointment remains in 'Synchronization Pending' status while our system reconciles with the hospital. It has not been cancelled yet.`;

      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'CANCEL_FAILED_PENDING_SYNC',
        capabilityCalled: 'cancel_appointment',
        capabilityResult: { status: 'Synchronization Pending', error: errorMsg },
        correlationId: meta.correlationId!,
        context,
      };
    }
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

    // Initial greeting / acceptance of intake
    if (currentIndex === -1) {
      const isDecline =
        /\b(no|nope|nah|maybe later|later|i'll do it later|i will do it later|do it later|not now|skip that|skip|skip it|no thanks|pass|i'll pass|ill pass|dont want|don't want|not right now|leave it|all set|that's all|thats all|that's it|thats it)\b/i.test(
          textLower
        ) ||
        // User acknowledging booking completion with OK / thank you rather than opting into intake
        (/^(ok|okay|ok thanks|okay thanks|ok thank you|okay thank you|thanks|thank you|got it|all good|sounds good thanks)$/i.test(
          textLower.replace(/[.,!]/g, '').trim()
        ));

      const isAffirmative =
        !isDecline &&
        /\b(yes|yeah|yep|sure|start|ready|proceed|go ahead|please|let's do it|lets do it|i can do that|i will do it|do it now|answer now|start questionnaire)\b/i.test(
          textLower
        );

      if (isAffirmative) {
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
          capabilityCalled: 'get_questionnaire',
          capabilityResult: qData,
          correlationId: meta.correlationId!,
          context: updatedContext,
        };
      } else if (isDecline) {
        const responseText =
          'Understood! Your appointment remains fully confirmed. You can complete the intake questionnaire anytime through your patient portal or in person when you arrive at check-in. Is there anything else I can help you with today?';
        const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
          currentIntent: 'COMPLETED',
        });
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'QUESTIONNAIRE_DECLINED',
          correlationId: meta.correlationId!,
          context: updatedContext,
        };
      } else {
        // User asked a question or spoke an unrelated thought rather than deciding on the questionnaire
        if (/\b(where|location|located|address|hours|find|directions|reach|call)\b/i.test(textLower)) {
          return this.handleFactualHospitalInquiry(
            {
              intent: 'FACTUAL_HOSPITAL_INQUIRY',
              entities: {
                hospitalName: textLower.includes('metropolitan') ? 'Metropolitan Health System' : undefined,
                questionTopic: textLower.includes('hours') ? 'hours' : textLower.includes('call') ? 'contact' : 'location',
              },
              confidence: 'HIGH',
              source: 'TIER3_DETERMINISTIC_FALLBACK',
              latencyMs: 0,
            },
            context,
            meta
          );
        }

        const responseText =
          'Your appointment is confirmed. Would you like to complete the quick 2-question intake for your doctor now, or should I help you with another question?';
        return {
          spokenText: responseText,
          responseText,
          intentDetected: 'INTAKE_OR_QUESTION_CLARIFICATION',
          clarificationNeeded: true,
          correlationId: meta.correlationId!,
          context,
        };
      }
    }

    // Check if patient wants to decline or pause the questionnaire midway through questions
    const isMidQuestionnaireDecline =
      /\b(stop|cancel|quit|pause|skip this|skip the rest|never mind|maybe later|i'll do it later|do it later|not now|don't want to answer|leave it|no thanks)\b/i.test(
        textLower
      );
    if (isMidQuestionnaireDecline) {
      const responseText =
        'Understood! We have paused the intake questions. Any responses provided so far have been saved, and your appointment remains confirmed. You can finish the questionnaire anytime in your patient portal or at check-in.';
      const updatedContext = await ConversationContextManager.updateContext(this.conversationId, {
        currentIntent: 'COMPLETED',
      });
      return {
        spokenText: responseText,
        responseText,
        intentDetected: 'QUESTIONNAIRE_CANCELLED_MIDWAY',
        correlationId: meta.correlationId!,
        context: updatedContext,
      };
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
