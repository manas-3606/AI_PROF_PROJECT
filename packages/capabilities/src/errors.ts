export abstract class CapabilityError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(
    message: string,
    public readonly capabilityName: string,
    public readonly correlationId?: string,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CapabilityValidationError extends CapabilityError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';

  constructor(
    message: string,
    capabilityName: string,
    correlationId?: string,
    details?: Record<string, any>
  ) {
    super(message, capabilityName, correlationId, details);
  }
}

export class CapabilityNotFoundError extends CapabilityError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';

  constructor(
    message: string,
    capabilityName: string,
    correlationId?: string,
    details?: Record<string, any>
  ) {
    super(message, capabilityName, correlationId, details);
  }
}

export class CapabilityConflictError extends CapabilityError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';

  constructor(
    message: string,
    capabilityName: string,
    correlationId?: string,
    details?: Record<string, any>
  ) {
    super(message, capabilityName, correlationId, details);
  }
}

export class CapabilityUnauthorizedError extends CapabilityError {
  readonly statusCode = 403;
  readonly code = 'UNAUTHORIZED';

  constructor(
    message: string,
    capabilityName: string,
    correlationId?: string,
    details?: Record<string, any>
  ) {
    super(message, capabilityName, correlationId, details);
  }
}

export class CapabilityExternalFailureError extends CapabilityError {
  readonly statusCode = 502;
  readonly code = 'EXTERNAL_FAILURE';
  readonly externalSystem?: string;

  constructor(
    message: string,
    capabilityName: string,
    correlationId?: string,
    details?: Record<string, any>,
    externalSystem?: string
  ) {
    super(message, capabilityName, correlationId, details);
    this.externalSystem = externalSystem || (details as any)?.externalSystem;
  }
}
