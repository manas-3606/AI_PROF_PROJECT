import { PatientAccessAgent, AgentTurnResponse } from '@health/capabilities';

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
 * Delegates to the unified PatientAccessAgent brain.
 */
export class PatientVoiceAgentBrain {
  private agent: PatientAccessAgent;

  constructor(conversationId: string, patientId?: string, hospitalId?: string) {
    this.agent = new PatientAccessAgent({
      conversationId,
      patientId,
      hospitalId,
      channel: 'VOICE',
    });
  }

  async processTurn(userUtterance: string): Promise<DialogueTurnResponse> {
    const result: AgentTurnResponse = await this.agent.processTurn(userUtterance);
    return {
      spokenText: result.spokenText,
      intentDetected: result.intentDetected,
      capabilityCalled: result.capabilityCalled,
      capabilityResult: result.capabilityResult,
      clarificationNeeded: result.clarificationNeeded,
      transferredToHuman: result.transferredToHuman,
      correlationId: result.correlationId,
    };
  }
}
