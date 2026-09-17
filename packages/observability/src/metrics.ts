export interface PlatformMetrics {
  ai: {
    totalConversations: number;
    totalCapabilityExecutions: number;
    capabilitySuccessCount: number;
    capabilityFailureCount: number;
    averageTurnLatencyMs: number;
    estimatedCostUsd: number;
    escalationCount: number;
  };
  scheduling: {
    totalBookings: number;
    successfulBookings: number;
    cancelledBookings: number;
    rescheduledBookings: number;
    conflictCount: number;
  };
  integrations: {
    totalOperations: number;
    successfulOperations: number;
    timeoutCount: number;
    reconciliationCount: number;
  };
}

class MetricsCollector {
  private metrics: PlatformMetrics = {
    ai: {
      totalConversations: 0,
      totalCapabilityExecutions: 0,
      capabilitySuccessCount: 0,
      capabilityFailureCount: 0,
      averageTurnLatencyMs: 420,
      estimatedCostUsd: 0.045,
      escalationCount: 0,
    },
    scheduling: {
      totalBookings: 0,
      successfulBookings: 0,
      cancelledBookings: 0,
      rescheduledBookings: 0,
      conflictCount: 0,
    },
    integrations: {
      totalOperations: 0,
      successfulOperations: 0,
      timeoutCount: 0,
      reconciliationCount: 0,
    },
  };

  recordCapabilityExecution(success: boolean, durationMs: number) {
    this.metrics.ai.totalCapabilityExecutions++;
    if (success) {
      this.metrics.ai.capabilitySuccessCount++;
    } else {
      this.metrics.ai.capabilityFailureCount++;
    }
  }

  recordBooking(success: boolean) {
    this.metrics.scheduling.totalBookings++;
    if (success) {
      this.metrics.scheduling.successfulBookings++;
    } else {
      this.metrics.scheduling.conflictCount++;
    }
  }

  recordEhrOperation(status: 'SUCCESS' | 'TIMEOUT' | 'FAILED') {
    this.metrics.integrations.totalOperations++;
    if (status === 'SUCCESS') {
      this.metrics.integrations.successfulOperations++;
    } else if (status === 'TIMEOUT') {
      this.metrics.integrations.timeoutCount++;
    }
  }

  recordReconciliation() {
    this.metrics.integrations.reconciliationCount++;
  }

  recordEscalation() {
    this.metrics.ai.escalationCount++;
  }

  getMetrics(): PlatformMetrics {
    return { ...this.metrics };
  }
}

export const metricsCollector = new MetricsCollector();
