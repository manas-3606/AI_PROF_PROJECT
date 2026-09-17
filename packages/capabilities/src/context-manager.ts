import { prisma } from '@health/db';
import { logger } from '@health/observability';

export interface ActiveContext {
  currentIntent?: string;
  selectedHospitalId?: string;
  selectedDoctorId?: string;
  selectedSlotId?: string;
  activeAppointmentId?: string;
  preferences?: Record<string, any>;
  relevantPreferences?: Record<string, any>;
  completedWorkflowState?: Record<string, any>;
  lastOfferedSlotIds?: string[];
  ambiguousOptions?: any[];
  historySummary?: string;
}

export class ConversationContextManager {
  static async getContext(conversationId: string): Promise<ActiveContext> {
    const record = await prisma.aiContext.findUnique({
      where: { conversationId },
    });

    if (!record) {
      return {};
    }

    try {
      const extra = JSON.parse(record.contextJson || '{}');
      const prefs = extra.relevantPreferences || extra.preferences;
      return {
        currentIntent: record.currentIntent || undefined,
        selectedHospitalId: record.selectedHospitalId || undefined,
        selectedDoctorId: record.selectedDoctorId || undefined,
        selectedSlotId: record.selectedSlotId || undefined,
        activeAppointmentId: record.activeAppointmentId || undefined,
        preferences: prefs,
        relevantPreferences: prefs,
        completedWorkflowState: extra.completedWorkflowState,
        lastOfferedSlotIds: extra.lastOfferedSlotIds,
        ambiguousOptions: extra.ambiguousOptions,
        historySummary: extra.historySummary,
      };
    } catch {
      return {};
    }
  }

  static async createContext(conversationId: string, initialContext: Partial<ActiveContext> = {}): Promise<ActiveContext> {
    return this.updateContext(conversationId, initialContext);
  }

  static async updateContext(conversationId: string, updates: Partial<ActiveContext>): Promise<ActiveContext> {
    const current = await this.getContext(conversationId);
    const merged: ActiveContext = {
      ...current,
      ...updates,
    };

    if (updates.preferences && !updates.relevantPreferences) {
      merged.relevantPreferences = updates.preferences;
    }
    if (updates.relevantPreferences && !updates.preferences) {
      merged.preferences = updates.relevantPreferences;
    }

    const extraFields = {
      preferences: merged.preferences,
      relevantPreferences: merged.relevantPreferences,
      completedWorkflowState: merged.completedWorkflowState,
      lastOfferedSlotIds: merged.lastOfferedSlotIds,
      ambiguousOptions: merged.ambiguousOptions,
      historySummary: merged.historySummary,
    };

    // Ensure parent aiConversation exists to satisfy foreign key constraint
    await prisma.aiConversation.upsert({
      where: { id: conversationId },
      update: { lastActivity: new Date() },
      create: {
        id: conversationId,
        channel: 'text_chat',
      },
    });

    await prisma.aiContext.upsert({
      where: { conversationId },
      update: {
        currentIntent: merged.currentIntent,
        selectedHospitalId: merged.selectedHospitalId,
        selectedDoctorId: merged.selectedDoctorId,
        selectedSlotId: merged.selectedSlotId,
        activeAppointmentId: merged.activeAppointmentId,
        contextJson: JSON.stringify(extraFields),
      },
      create: {
        conversationId,
        currentIntent: merged.currentIntent,
        selectedHospitalId: merged.selectedHospitalId,
        selectedDoctorId: merged.selectedDoctorId,
        selectedSlotId: merged.selectedSlotId,
        activeAppointmentId: merged.activeAppointmentId,
        contextJson: JSON.stringify(extraFields),
      },
    });

    logger.debug({ conversationId, merged }, 'Updated conversation context');
    return merged;
  }
}
