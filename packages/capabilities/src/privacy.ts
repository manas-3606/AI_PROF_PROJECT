/**
 * Privacy & PHI redaction utilities complying with PRD Section 21 & ADR-009.
 * Sensitive fields (phone, email, symptoms, questionnaire answers, notes, passwords, tokens)
 * must NEVER be logged directly in raw audit events.
 */

export function maskPhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***-***';
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
}

export function maskEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***';
  const name = parts[0];
  const domain = parts[1];
  const maskedName = name.length <= 2 ? '*' : `${name[0]}***${name[name.length - 1]}`;
  return `${maskedName}@${domain}`;
}

/**
 * Creates a privacy-safe summary of raw capability input for audit events.
 */
export function sanitizeInputForAudit(capabilityName: string, rawInput: any): Record<string, any> {
  if (!rawInput || typeof rawInput !== 'object') {
    return {};
  }

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(rawInput)) {
    if (value === undefined || value === null) {
      continue;
    }

    const lowerKey = key.toLowerCase();

    // Redact passwords, secrets, tokens
    if (lowerKey.includes('password') || lowerKey.includes('secret') || lowerKey.includes('token')) {
      sanitized[key] = '[REDACTED_CREDENTIAL]';
      continue;
    }

    // Mask phone numbers
    if (lowerKey.includes('phone')) {
      sanitized[key] = typeof value === 'string' ? maskPhone(value) : '[REDACTED_PHONE]';
      continue;
    }

    // Mask emails
    if (lowerKey.includes('email')) {
      sanitized[key] = typeof value === 'string' ? maskEmail(value) : '[REDACTED_EMAIL]';
      continue;
    }

    // Mask questionnaire responses / medical answers / sensitive health details
    if (lowerKey.includes('response') || lowerKey.includes('answer') || lowerKey.includes('payload')) {
      if (typeof value === 'object') {
        sanitized[key] = `[STRUCTURED_DATA_KEYS: ${Object.keys(value).join(', ')}]`;
      } else {
        sanitized[key] = '[REDACTED_HEALTH_DATA]';
      }
      continue;
    }

    // Mask notes or clinical reasons containing potential medical narratives
    if (lowerKey === 'notes' || lowerKey === 'reason') {
      if (typeof value === 'string') {
        sanitized[key] = `[REDACTED_TEXT length=${value.length}]`;
      } else {
        sanitized[key] = '[REDACTED_TEXT]';
      }
      continue;
    }

    // Nested identifier object (e.g., in lookup_patient)
    if (key === 'identifier' && value && typeof value === 'object') {
      const idObj = value as Record<string, any>;
      sanitized.identifier = {
        phone: idObj.phone ? maskPhone(String(idObj.phone)) : undefined,
        email: idObj.email ? maskEmail(String(idObj.email)) : undefined,
        externalPatientId: idObj.externalPatientId ? `EXT-***${String(idObj.externalPatientId).slice(-4)}` : undefined,
      };
      continue;
    }

    // Pass safe IDs, enum values, dates, pagination limits
    if (
      lowerKey.includes('id') ||
      lowerKey.includes('date') ||
      lowerKey.includes('status') ||
      lowerKey.includes('channel') ||
      lowerKey.includes('city') ||
      lowerKey.includes('specialty') ||
      lowerKey.includes('type') ||
      lowerKey.includes('key')
    ) {
      sanitized[key] = value;
    } else if (typeof value === 'string' && value.length > 50) {
      sanitized[key] = `[TEXT length=${value.length}]`;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
