import { PatientAccessAgent, AgentTurnResponse } from '@health/capabilities';
import { logger } from '@health/observability';

export interface DialogueTurnResponse {
  spokenText: string;
  intentDetected?: string;
  capabilityCalled?: string;
  capabilityResult?: any;
  clarificationNeeded?: boolean;
  transferredToHuman?: boolean;
  correlationId?: string;
}

/**
 * Voice Gateway adapter for the AI Patient Access Agent (PRD Section 9 & 20).
 * Delegates to the unified PatientAccessAgent brain with structured logging.
 */
export class PatientVoiceAgentBrain {
  private agent: PatientAccessAgent;
  private conversationId: string;
  private patientId?: string;
  private hospitalId?: string;

  constructor(conversationId: string, patientId?: string, hospitalId?: string) {
    this.conversationId = conversationId;
    this.patientId = patientId;
    this.hospitalId = hospitalId;
    this.agent = new PatientAccessAgent({
      conversationId,
      patientId,
      hospitalId,
      channel: 'VOICE',
    });
  }

  setContext(patientId?: string, hospitalId?: string) {
    if (patientId) this.patientId = patientId;
    if (hospitalId) this.hospitalId = hospitalId;
  }

  async processTurn(
    userUtterance: string,
    correlationId?: string,
    abortSignal?: AbortSignal,
    patientId?: string,
    hospitalId?: string
  ): Promise<DialogueTurnResponse> {
    const effectivePatientId = patientId || this.patientId;
    const effectiveHospitalId = hospitalId || this.hospitalId;

    const turnCorrelationId = correlationId || `turn-${Date.now()}`;
    logger.info(
      {
        conversationId: this.conversationId,
        correlationId: turnCorrelationId,
        patientId: effectivePatientId,
        hospitalId: effectiveHospitalId,
        event: 'AI_AGENT_TURN_START',
        utterance: userUtterance,
      },
      'Voice agent processing conversational turn'
    );

    if (abortSignal?.aborted) {
      logger.warn(
        {
          conversationId: this.conversationId,
          correlationId: turnCorrelationId,
          event: 'AI_AGENT_TURN_ABORTED_PRE_EXECUTION',
        },
        'Turn execution aborted prior to capability dispatch'
      );
      throw new Error('TURN_ABORTED');
    }

    const startTime = Date.now();
    const result: AgentTurnResponse = await this.agent.processTurn({
      conversationId: this.conversationId,
      userUtterance,
      patientId: effectivePatientId,
      hospitalId: effectiveHospitalId,
      correlationId: turnCorrelationId,
      channel: 'VOICE',
    });
    const durationMs = Date.now() - startTime;

    if (abortSignal?.aborted) {
      logger.warn(
        {
          conversationId: this.conversationId,
          correlationId: turnCorrelationId,
          event: 'AI_AGENT_TURN_ABORTED_POST_EXECUTION',
          durationMs,
        },
        'Turn execution finished but caller signal was aborted'
      );
    }

    if (result.capabilityCalled) {
      logger.info(
        {
          conversationId: this.conversationId,
          correlationId: turnCorrelationId,
          event: 'TOOL_CALL_RESOLVED',
          capability: result.capabilityCalled,
          clarificationNeeded: result.clarificationNeeded,
          durationMs,
        },
        `Tool call resolved: ${result.capabilityCalled}`
      );
    }

    logger.info(
      {
        conversationId: this.conversationId,
        correlationId: turnCorrelationId,
        event: 'AI_AGENT_TURN_END',
        intentDetected: result.intentDetected,
        durationMs,
      },
      'Voice agent completed conversational turn'
    );

    return {
      spokenText: result.spokenText,
      intentDetected: result.intentDetected,
      capabilityCalled: result.capabilityCalled,
      capabilityResult: result.capabilityResult,
      clarificationNeeded: result.clarificationNeeded,
      transferredToHuman: result.transferredToHuman,
      correlationId: result.correlationId || turnCorrelationId,
    };
  }
}
