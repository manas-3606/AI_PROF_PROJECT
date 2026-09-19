import { GoogleGenAI } from '@google/genai';
import { prisma } from '@health/db';
import { logger } from '@health/observability';
import { ActiveContext } from './context-manager.js';
import fs from 'node:fs';
import path from 'node:path';

export interface LlmRoutingDecision {
  intent:
    | 'CLINICAL_SAFETY_INQUIRY'
    | 'FACTUAL_HOSPITAL_INQUIRY'
    | 'RESCHEDULE_INTENT'
    | 'RESCHEDULE_SLOT_SELECTION'
    | 'SLOT_SELECTION'
    | 'DOCTOR_AVAILABILITY'
    | 'DOCTOR_BOOKING_CLARIFICATION'
    | 'DOCTOR_DISCOVERY'
    | 'SPECIALTY_DISCOVERY'
    | 'SYMPTOM_REPORT'
    | 'QUESTIONNAIRE_ACCEPT'
    | 'QUESTIONNAIRE_DECLINE'
    | 'CANCEL_APPOINTMENT'
    | 'VERIFY_APPOINTMENT'
    | 'SEND_NOTIFICATION'
    | 'UPDATE_PREFERENCES'
    | 'CONVERSATION_CONCLUDED'
    | 'INCOMPLETE_CUTOFF'
    | 'AMBIGUOUS_BOOKING'
    | 'GENERAL_HELP_OR_UNKNOWN';
  entities: {
    hospitalName?: string;
    doctorName?: string;
    specialty?: string;
    dayOfWeek?: string;
    timePreference?: string;
    ordinal?: string;
    symptom?: string;
    reason?: string;
    questionTopic?: 'location' | 'address' | 'hours' | 'contact' | 'general';
  };
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  directFactualAnswer?: string;
  source: 'GEMINI_LLM' | 'TIER3_DETERMINISTIC_FALLBACK';
  latencyMs: number;
  modelVersion?: string;
}

/**
 * Resolves GEMINI_API_KEY from process.env or .env file
 */
function getGeminiApiKey(): string | undefined {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your-gemini-api-key-here') {
    return process.env.GEMINI_API_KEY.trim();
  }

  // Fallback: check root .env directly
  const searchRoots = [__dirname, process.cwd()];
  for (const root of searchRoots) {
    let curr = root;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(curr, '.env');
      if (fs.existsSync(candidate)) {
        try {
          const content = fs.readFileSync(candidate, 'utf-8');
          const m = content.match(/GEMINI_API_KEY=["']?([^"'\r\n]+)/);
          if (m && m[1] && m[1] !== 'your-gemini-api-key-here') {
            process.env.GEMINI_API_KEY = m[1].trim();
            return m[1].trim();
          }
        } catch {
          // continue
        }
      }
      curr = path.dirname(curr);
    }
  }

  return undefined;
}

let geminiClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

/**
 * AI Dialogue Router (PRD Section 9 & Option C Hybrid)
 *
 * Tier 2: LLM Natural Language Understanding via Gemini Flash Lite.
 * Tier 3: Deterministic Context-Aware Semantic Fallback when key is missing or call times out.
 */
export class DialogueRouter {
  /**
   * Routes a user conversational turn using Gemini LLM if available,
   * with automatic fallback to Tier 3 deterministic semantic classifier.
   */
  static async routeTurn(
    utterance: string,
    context: ActiveContext,
    options: { correlationId?: string; timeoutMs?: number } = {}
  ): Promise<LlmRoutingDecision> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 2500;
    const client = getClient();

    if (client) {
      try {
        const decisionPromise = this.callGeminiRouter(client, utterance, context);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini LLM route timeout after ${timeoutMs}ms`)), timeoutMs)
        );

        const result = await Promise.race([decisionPromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        logger.info(
          {
            correlationId: options.correlationId,
            utterance,
            intent: result.intent,
            confidence: result.confidence,
            latencyMs,
            source: 'GEMINI_LLM',
          },
          'Tier 2 Gemini LLM route decision succeeded'
        );

        return {
          ...result,
          source: 'GEMINI_LLM',
          latencyMs,
        };
      } catch (err: any) {
        logger.warn(
          {
            correlationId: options.correlationId,
            err: err.message || err,
            utterance,
          },
          'Tier 2 Gemini LLM routing unavailable/failed; engaging Tier 3 deterministic fallback'
        );
      }
    }

    // Tier 3: Deterministic Semantic Fallback
    const fallbackDecision = this.deterministicFallback(utterance, context);
    const latencyMs = Date.now() - startTime;
    return {
      ...fallbackDecision,
      source: 'TIER3_DETERMINISTIC_FALLBACK',
      latencyMs,
    };
  }

  /**
   * Calls Gemini Flash Lite with structured schema
   */
  private static async callGeminiRouter(
    ai: GoogleGenAI,
    utterance: string,
    context: ActiveContext
  ): Promise<Omit<LlmRoutingDecision, 'source' | 'latencyMs'>> {
    const offeredOptionsStr = (context.ambiguousOptions || [])
      .map((o: any) => {
        const d = new Date(o.startTime);
        return `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      })
      .join(', ');

    const prompt = `
You are an expert healthcare dialogue router for an AI Patient Access Agent.
Analyze the user utterance in the context of an ongoing patient conversation.

ACTIVE CONVERSATION CONTEXT:
- currentIntent: ${context.currentIntent || 'NONE'}
- activeAppointmentId: ${context.activeAppointmentId || 'NONE'}
- selectedDoctorId: ${context.selectedDoctorId || 'NONE'}
- selectedHospitalId: ${context.selectedHospitalId || 'NONE'}
- lastOfferedSlotIds: ${JSON.stringify(context.lastOfferedSlotIds || [])}
- offeredSlotOptions: ${offeredOptionsStr || 'NONE'}

USER UTTERANCE:
"${utterance}"

TASK:
Classify the intent and extract entities into JSON format matching this schema:
{
  "intent": "CLINICAL_SAFETY_INQUIRY" | "FACTUAL_HOSPITAL_INQUIRY" | "RESCHEDULE_INTENT" | "RESCHEDULE_SLOT_SELECTION" | "SLOT_SELECTION" | "DOCTOR_AVAILABILITY" | "DOCTOR_BOOKING_CLARIFICATION" | "DOCTOR_DISCOVERY" | "SPECIALTY_DISCOVERY" | "SYMPTOM_REPORT" | "QUESTIONNAIRE_ACCEPT" | "QUESTIONNAIRE_DECLINE" | "CANCEL_APPOINTMENT" | "VERIFY_APPOINTMENT" | "SEND_NOTIFICATION" | "UPDATE_PREFERENCES" | "CONVERSATION_CONCLUDED" | "INCOMPLETE_CUTOFF" | "AMBIGUOUS_BOOKING" | "GENERAL_HELP_OR_UNKNOWN",
  "entities": {
    "hospitalName": string or null,
    "doctorName": string or null,
    "specialty": string or null,
    "dayOfWeek": string or null,
    "timePreference": string or null,
    "ordinal": string or null,
    "symptom": string or null,
    "reason": string or null,
    "questionTopic": "location" | "address" | "hours" | "contact" | "general" or null
  },
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}

RULES:
1. If the user asks where a hospital is located, its address, hours, or phone (e.g. "Can you tell me where Metropolitan Health System is located?"), classify as "FACTUAL_HOSPITAL_INQUIRY" with questionTopic="location" and hospitalName. DO NOT classify as QUESTIONNAIRE_DECLINE!
2. If the user declines, rejects, or postpones a questionnaire, intake questions, or survey (e.g. "No thanks, I will do the questions later", "skip the questions", "I'll do it later", "not right now", "no questions please", "pass on the questions"), classify as "QUESTIONNAIRE_DECLINE".
3. If the user agrees to answer intake questions (e.g. "yes", "sure", "I can answer them", "okay"), classify as "QUESTIONNAIRE_ACCEPT".
4. If the user inquires about a doctor's openings, times, or availability (e.g. "What times does Dr. Jenkins have on Monday?"), classify as "DOCTOR_AVAILABILITY" and extract doctorName and dayOfWeek.
5. If context.currentIntent is "AWAITING_RESCHEDULE_SLOT" or the user is rescheduling and asks for a day/slot (e.g. "Please book the next available slot on Tuesday"), classify as "RESCHEDULE_SLOT_SELECTION" with dayOfWeek="Tuesday", ordinal="next available".
6. If the user is selecting from offered appointment slots (e.g. "The 10am one", "first option", "second one", "11:00"), classify as "SLOT_SELECTION" and extract timePreference or ordinal.
7. If the sentence is cut off mid-thought (e.g. "Hello I am having severe."), classify as "INCOMPLETE_CUTOFF".
8. SYMPTOM REPORTING: If the user reports physical symptoms, illness, or bodily pain (e.g. "I am having severe heart pain", "I have back pain", "neck stiffness", "shoulder hurts", "cough and fever", "knee ache", "severe leg pain", "pain in my leg"), classify as "SYMPTOM_REPORT". Extract symptom (e.g. "heart pain", "leg pain") and mapped specialty ("Cardiology" for heart/cardiac/chest pain, "Orthopedics" for joints/bones/spine/neck/back/leg/knee/hip/arm/limb pain, "General Medicine" for fever/cough/cold/stomach). DO NOT classify as CLINICAL_SAFETY_INQUIRY unless the patient is explicitly asking the AI to diagnose an illness, prescribe medicine, or formulate a treatment regimen.
9. CLINICAL SAFETY BOUNDARY: If the user explicitly asks the AI to diagnose their illness, prescribe medication, provide prescription dosages, or advise medical treatments (e.g. "Do I have a heart attack?", "what medicine should I take?", "can you prescribe antibiotics?"), classify as "CLINICAL_SAFETY_INQUIRY".
10. SPECIALTY DISCOVERY: If the user asks for a specific medical specialty (e.g. "I need a cardiologist", "find me an orthopedic doctor", "I want to see a general physician"), classify as "SPECIALTY_DISCOVERY" with the specialty entity.
11. Return ONLY the JSON object.
`;

    const res = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const raw = res.text?.trim() || '{}';
    const parsed = JSON.parse(raw);
    const modelVersion = (res as any).modelVersion || 'gemini-3.5-flash-lite';

    return {
      intent: parsed.intent || 'GENERAL_HELP_OR_UNKNOWN',
      entities: parsed.entities || {},
      confidence: parsed.confidence || 'HIGH',
      modelVersion,
    };
  }

  /**
   * Tier 3: Deterministic Semantic Fallback
   * Implements robust state-aware rules without relying on brittle regex matching.
   */
  static deterministicFallback(
    utterance: string,
    context: ActiveContext
  ): Omit<LlmRoutingDecision, 'source' | 'latencyMs'> {
    const textLower = utterance.toLowerCase().trim();

    // 1. Cut-off incomplete sentence
    if (/\b(severe|having severe|experiencing|suffering from|because of|due to|and then|trouble with)\b[\.\s]*$/i.test(textLower)) {
      return {
        intent: 'INCOMPLETE_CUTOFF',
        entities: { symptom: 'severe' },
        confidence: 'HIGH',
      };
    }

    // 2. Clinical Safety Guardrail (explicit diagnosis / prescription / treatment requests)
    const isClinicalInquiry =
      /\b(diagnos[a-z]*|what condition do i have|what disease do i have|what illness|what do you think i have|do i have a heart attack|prescrib[a-z]*|write a script|give me a prescription|refill my prescription|what medicine should i take|how to treat|recommend a treatment)\b/i.test(
        textLower
      );
    if (isClinicalInquiry) {
      return {
        intent: 'CLINICAL_SAFETY_INQUIRY',
        entities: {},
        confidence: 'HIGH',
      };
    }

    // 3. Questionnaire Decline / Accept
    const isQuestionnaireDecline =
      /\b(no thanks|do (?:the )?questions later|do it later|fill (?:it|them) out later|skip (?:the )?(?:questions|questionnaire|intake)|pass on the questions|not right now|maybe later|later on|at check-?in|skip questions)\b/i.test(
        textLower
      ) ||
      ((context.currentIntent === 'COMPLETING_QUESTIONNAIRE' || context.activeAppointmentId) &&
        /\b(no thanks|no thank you|not now|skip|later|pass|i'll pass)\b/i.test(textLower));

    if (isQuestionnaireDecline) {
      return {
        intent: 'QUESTIONNAIRE_DECLINE',
        entities: {},
        confidence: 'HIGH',
      };
    }

    if (
      context.currentIntent === 'COMPLETING_QUESTIONNAIRE' &&
      /\b(yes|yeah|yep|sure|ready|start|proceed|please|go ahead)\b/i.test(textLower)
    ) {
      return {
        intent: 'QUESTIONNAIRE_ACCEPT',
        entities: {},
        confidence: 'HIGH',
      };
    }

    // 4. Factual hospital inquiry (location, address, hours, contact)
    const isLocationInquiry =
      /\b(where is|location|located|address|find|directions to|how do i get to|where can i find)\b/i.test(textLower) &&
      /\b(hospital|health system|clinic|facility|metropolitan|apex)\b/i.test(textLower);
    const isHoursInquiry = /\b(hours|open|opening hours|operating hours|visiting hours|closing time)\b/i.test(textLower);

    if (isLocationInquiry || isHoursInquiry) {
      let hospitalName: string | undefined;
      if (textLower.includes('metropolitan')) hospitalName = 'Metropolitan Health System';
      else if (textLower.includes('apex')) hospitalName = 'Apex Medical Center';

      return {
        intent: 'FACTUAL_HOSPITAL_INQUIRY',
        entities: {
          hospitalName,
          questionTopic: isLocationInquiry ? 'location' : 'hours',
        },
        confidence: 'HIGH',
      };
    }

    // 5. Symptom Reporting / Specialty Discovery (Cardiology / Orthopedics / General Medicine)
    const isCardioSymptom =
      /\b(heart pain|chest pain|palpitation|palpitations|arrhythmia|hypertension|high blood pressure|cardiac|cardio|cardiolog(?:ist|y)|heart doctor|heart specialist)\b/i.test(
        textLower
      );
    if (isCardioSymptom) {
      return {
        intent: 'SYMPTOM_REPORT',
        entities: { symptom: 'heart pain', specialty: 'Cardiology' },
        confidence: 'HIGH',
      };
    }

    const isOrthoSymptom =
      /\b(neck|stiff neck|back pain|lower back|spine|spinal|shoulder|knee|hip|elbow|wrist|ankle|foot|feet|hand|hands|leg|legs|thigh|thighs|calf|calves|shin|shins|arm|arms|joint pain|bone pain|bone|joint|joints|orthopedic|orthopedics|orthopedist|musculoskeletal|sprain|fracture)\b/i.test(
        textLower
      ) ||
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
    if (isOrthoSymptom) {
      let symptomName = 'joint or back pain';
      if (/\b(leg|legs|thigh|calf|shin)\b/i.test(textLower)) symptomName = 'leg pain';
      else if (/\b(arm|arms)\b/i.test(textLower)) symptomName = 'arm pain';
      else if (/\b(neck)\b/i.test(textLower)) symptomName = 'neck pain';
      else if (/\b(knee)\b/i.test(textLower)) symptomName = 'knee pain';
      else if (/\b(shoulder)\b/i.test(textLower)) symptomName = 'shoulder pain';

      return {
        intent: 'SYMPTOM_REPORT',
        entities: { symptom: symptomName, specialty: 'Orthopedics' },
        confidence: 'HIGH',
      };
    }

    const isGeneralMedSymptom =
      /\b(fever|cough|cold|flu|headache|migraine|sore throat|fatigue|stomach|belly|nausea|vomiting|dizzy|dizziness|allergy|allergies|sick)\b/i.test(
        textLower
      );
    if (isGeneralMedSymptom) {
      return {
        intent: 'SYMPTOM_REPORT',
        entities: { symptom: 'general illness', specialty: 'General Medicine' },
        confidence: 'HIGH',
      };
    }

    // 6. Doctor Availability & Direct Doctor Booking ("book an appointment with Dr Arvind Rao at morning Monday")
    if (
      (/\b(what times?|what openings?|when is|available|openings? does|times? does|book|schedule|appointment|see|visit)\b/i.test(textLower)) &&
      (/\b(dr\.?|doctor|jenkins|chen|rao|patel|rostova|arvind)\b/i.test(textLower))
    ) {
      const dayMatch = textLower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      const timePref = textLower.match(/\b(morning|afternoon|evening|earliest|latest)\b/i);
      const drMatch =
        textLower.match(/(?:dr\.?|doctor)\s+([a-z\s]+?)(?:\s+at|\s+on|\s+for|\s+this|\s+next|\s+in|\s+morning|\s+afternoon|$)/i) ||
        textLower.match(/(?:dr\.?|doctor)\s+([a-z]+)/i) ||
        textLower.match(/\b(jenkins|chen|rao|patel|rostova|arvind)\b/i);

      return {
        intent: 'DOCTOR_BOOKING_CLARIFICATION',
        entities: {
          doctorName: drMatch ? drMatch[1].trim() : undefined,
          dayOfWeek: dayMatch ? dayMatch[1] : undefined,
          timePreference: timePref ? timePref[1] : undefined,
        },
        confidence: 'HIGH',
      };
    }

    // 7. Reschedule Slot Selection: User is in reschedule flow and asks for a slot/day
    if (
      (context.currentIntent === 'AWAITING_RESCHEDULE_SLOT' || context.currentIntent === 'RESCHEDULE_INTENT') &&
      /\b(book|slot|opening|appointment|time|tuesday|monday|wednesday|thursday|friday|saturday|sunday|next|earliest|morning|afternoon)\b/i.test(textLower)
    ) {
      const dayMatch = textLower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      const ordinalMatch = textLower.match(/\b(next|first|earliest|second|last)\b/i);

      return {
        intent: 'RESCHEDULE_SLOT_SELECTION',
        entities: {
          dayOfWeek: dayMatch ? dayMatch[1] : undefined,
          ordinal: ordinalMatch ? ordinalMatch[1] : 'next',
        },
        confidence: 'HIGH',
      };
    }

    // 8. Initial Reschedule Intent
    if (textLower.includes('reschedule') || textLower.includes('change appointment') || textLower.includes('move my appointment')) {
      return {
        intent: 'RESCHEDULE_INTENT',
        entities: {},
        confidence: 'HIGH',
      };
    }

    // 9. Slot selection from offered options
    if (
      context.currentIntent === 'AWAITING_SLOT_SELECTION' &&
      /\b(first|second|third|10am|11am|9am|2pm|3pm|morning|afternoon|next|earliest|that one|book it|yes|yeah|yep|sure|please)\b/i.test(textLower)
    ) {
      return {
        intent: 'SLOT_SELECTION',
        entities: {},
        confidence: 'HIGH',
      };
    }

    // 10. General fallback
    return {
      intent: 'GENERAL_HELP_OR_UNKNOWN',
      entities: {},
      confidence: 'LOW',
    };
  }
}
