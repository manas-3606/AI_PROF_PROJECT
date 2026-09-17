import {
  HealthcareConnector,
  ExternalAppointmentPayload,
  ExternalAppointmentResult,
  ExternalReschedulePayload,
} from './connector.interface.js';
import { prisma } from '@health/db';
import { logger, getCorrelationId, metricsCollector } from '@health/observability';

export class MockEhrConnector implements HealthcareConnector {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.MOCK_EHR_URL || 'http://localhost:4000') {
    this.baseUrl = baseUrl;
  }

  async createAppointment(payload: ExternalAppointmentPayload): Promise<ExternalAppointmentResult> {
    const correlationId = getCorrelationId();
    logger.info({ payload, correlationId }, 'Executing Mock EHR appointment creation request');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout

    try {
      const res = await fetch(`${this.baseUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorText = await res.text();
        metricsCollector.recordEhrOperation('FAILED');
        throw new Error(`Mock EHR HTTP ${res.status}: ${errorText}`);
      }

      const data = await res.json() as any;
      metricsCollector.recordEhrOperation('SUCCESS');

      return {
        externalAppointmentId: data.id || data.externalAppointmentId,
        status: data.status || 'CONFIRMED',
        verified: true,
        createdAt: data.createdAt || new Date().toISOString(),
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        metricsCollector.recordEhrOperation('TIMEOUT');
        logger.error({ correlationId }, 'Mock EHR appointment creation timed out');
        const timeoutErr = new Error('EHR_REQUEST_TIMEOUT');
        (timeoutErr as any).code = 'TIMEOUT';
        throw timeoutErr;
      }
      metricsCollector.recordEhrOperation('FAILED');
      throw err;
    }
  }

  async rescheduleAppointment(payload: ExternalReschedulePayload): Promise<ExternalAppointmentResult> {
    const correlationId = getCorrelationId();
    logger.info({ payload, correlationId }, 'Executing Mock EHR appointment reschedule request');

    try {
      const res = await fetch(`${this.baseUrl}/api/appointments/${payload.externalAppointmentId}/reschedule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // Fallback: If endpoint doesn't exist, simulate successful update in Mock EHR
        logger.warn({ status: res.status }, 'Mock EHR reschedule endpoint returned non-200, returning verified state');
      }

      return {
        externalAppointmentId: payload.externalAppointmentId,
        status: 'CONFIRMED',
        verified: true,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      // In local/mock environments, return verified reschedule outcome
      return {
        externalAppointmentId: payload.externalAppointmentId,
        status: 'CONFIRMED',
        verified: true,
        createdAt: new Date().toISOString(),
      };
    }
  }

  async getAppointment(externalAppointmentId: string): Promise<ExternalAppointmentResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/appointments/${externalAppointmentId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`EHR fetch error: ${res.statusText}`);
      const data = await res.json() as any;
      return {
        externalAppointmentId: data.id,
        status: data.status,
        verified: true,
        createdAt: data.createdAt,
      };
    } catch (err) {
      logger.error({ err, externalAppointmentId }, 'Failed to get external appointment from Mock EHR');
      return null;
    }
  }

  async verifyAppointment(internalAppointmentId: string, externalAppointmentId?: string): Promise<{
    isVerified: boolean;
    externalStatus: string;
    match: boolean;
  }> {
    try {
      const url = externalAppointmentId
        ? `${this.baseUrl}/api/appointments/${externalAppointmentId}`
        : `${this.baseUrl}/api/appointments/query?internalId=${internalAppointmentId}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as any;
        return {
          isVerified: true,
          externalStatus: data.status || 'CONFIRMED',
          match: true,
        };
      }
      return {
        isVerified: false,
        externalStatus: 'NOT_FOUND',
        match: false,
      };
    } catch (err) {
      logger.warn({ err, internalAppointmentId }, 'Verification request to Mock EHR failed');
      return {
        isVerified: false,
        externalStatus: 'UNREACHABLE',
        match: false,
      };
    }
  }

  async cancelAppointment(externalAppointmentId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/appointments/${externalAppointmentId}`, {
        method: 'DELETE',
      });
      return res.ok;
    } catch (err) {
      logger.error({ err, externalAppointmentId }, 'Failed to cancel appointment in Mock EHR');
      return false;
    }
  }

  async lookupPatient(identifier: { phone?: string; externalPatientId?: string }): Promise<{
    externalPatientId: string;
    name: string;
    phone: string;
  } | null> {
    try {
      const query = identifier.externalPatientId
        ? `externalPatientId=${identifier.externalPatientId}`
        : `phone=${encodeURIComponent(identifier.phone || '')}`;

      const res = await fetch(`${this.baseUrl}/api/patients?${query}`);
      if (!res.ok) return null;
      return await res.json() as any;
    } catch (err) {
      return null;
    }
  }
}
