import pino from 'pino';
import { getRequestContext } from './correlation.js';

const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'phone',
      'email',
      'dateOfBirth',
      'dob',
      'answers',
      'symptoms',
      'reason',
      'responses.*',
      'payload.phone',
      'payload.email',
      'headers.authorization',
    ],
    censor: '[REDACTED_PHI]',
  },
  formatters: {
    log(object) {
      const ctx = getRequestContext();
      return {
        ...object,
        correlationId: ctx.correlationId,
        tenantId: ctx.tenantId,
      };
    },
  },
});

export const logger = baseLogger;
