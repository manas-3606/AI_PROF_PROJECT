import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';

const fastify = Fastify({ logger: true });

// Chaos configuration state
interface ChaosConfig {
  simulatedLatencyMs: number;
  failureMode: 'NONE' | 'TIMEOUT' | '500_ERROR' | 'ERROR_500' | 'PHANTOM_CREATION';
}

let chaosConfig: ChaosConfig = {
  simulatedLatencyMs: 0,
  failureMode: 'NONE',
};

// In-memory EHR records
interface EhrAppointment {
  id: string;
  internalAppointmentId: string;
  externalPatientId: string;
  externalProviderId: string;
  startTime: string;
  endTime: string;
  status: string;
  reason?: string;
  createdAt: string;
}

const ehrAppointments: Map<string, EhrAppointment> = new Map();

// Seed initial EHR providers & patients
const ehrProviders = [
  { id: 'EXT-DOC-RAO-01', name: 'Dr. Arvind Rao', specialty: 'Orthopedics' },
  { id: 'EXT-DOC-PATEL-02', name: 'Dr. Maya Patel', specialty: 'Cardiology' },
];

const ehrPatients = [
  { id: 'EXT-PAT-DOE-99', name: 'John Doe', phone: '+1-555-0199', dob: '1988-04-12' },
];

const ehrFacilities = [
  { id: 'EXT-FAC-APEX-01', name: 'Apex Health Center', address: '123 Medical Center Way' },
  { id: 'EXT-FAC-METRO-02', name: 'Metro General Hospital', address: '456 Healthcare Blvd' },
];

async function start() {
  await fastify.register(cors, { origin: '*' });

  // Health Check
  fastify.get('/health', async () => ({ status: 'UP', service: 'mock-ehr' }));

  // 1. Chaos Configuration Endpoints
  fastify.get('/chaos/status', async () => {
    return {
      chaosConfig,
      totalEhrAppointments: ehrAppointments.size,
    };
  });

  fastify.post('/chaos/configure', async (request) => {
    const body = request.body as Partial<ChaosConfig>;
    chaosConfig = {
      simulatedLatencyMs: body.simulatedLatencyMs ?? chaosConfig.simulatedLatencyMs,
      failureMode: body.failureMode ?? chaosConfig.failureMode,
    };
    return { success: true, chaosConfig };
  });

  fastify.post('/chaos/reset', async () => {
    chaosConfig = { simulatedLatencyMs: 0, failureMode: 'NONE' };
    return { success: true, chaosConfig };
  });

  // 2. EHR API Endpoints
  fastify.get('/api/patients', async (request, reply) => {
    const query = request.query as { phone?: string; externalPatientId?: string };
    const patient = ehrPatients.find(
      (p) => (query.phone && p.phone === query.phone) || (query.externalPatientId && p.id === query.externalPatientId)
    );
    if (!patient) return reply.status(404).send({ error: 'Patient not found in EHR' });
    return patient;
  });

  fastify.get('/api/providers', async (request) => {
    const query = request.query as { id?: string; name?: string };
    if (query.id) {
      return ehrProviders.find((p) => p.id === query.id) || null;
    }
    if (query.name) {
      const lower = query.name.toLowerCase();
      return ehrProviders.find((p) => p.name.toLowerCase().includes(lower)) || null;
    }
    return ehrProviders;
  });

  fastify.get('/api/facilities', async (request) => {
    const query = request.query as { id?: string; name?: string };
    if (query.id) {
      return ehrFacilities.find((f) => f.id === query.id) || null;
    }
    if (query.name) {
      const lower = query.name.toLowerCase();
      return ehrFacilities.find((f) => f.name.toLowerCase().includes(lower)) || null;
    }
    return ehrFacilities;
  });

  fastify.get('/api/availability', async (request) => {
    const query = request.query as { providerId?: string; startDate?: string; endDate?: string };
    const providerId = query.providerId || 'EXT-DOC-RAO-01';
    const baseDate = query.startDate ? new Date(query.startDate) : new Date();
    // Return sample slots
    const slots = [];
    for (let i = 0; i < 3; i++) {
      const start = new Date(baseDate);
      start.setHours(9 + i * 2, 0, 0, 0);
      const end = new Date(start);
      end.setMinutes(start.getMinutes() + 30);
      slots.push({
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        available: true,
      });
    }
    return slots;
  });

  fastify.post('/api/appointments', async (request, reply) => {
    const body = request.body as {
      internalAppointmentId: string;
      externalPatientId: string;
      externalProviderId: string;
      startTime: string;
      endTime: string;
      reason?: string;
    };

    // Apply simulated latency if configured
    if (chaosConfig.simulatedLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, chaosConfig.simulatedLatencyMs));
    }

    // Evaluate Chaos failure modes
    if (chaosConfig.failureMode === '500_ERROR' || chaosConfig.failureMode === 'ERROR_500') {
      return reply.status(500).send({
        error: 'EHR_INTERNAL_SERVER_ERROR',
        message: 'Simulated EHR downstream database unavailable',
      });
    }

    if (chaosConfig.failureMode === 'TIMEOUT') {
      // Delay longer than client 4s timeout
      await new Promise((resolve) => setTimeout(resolve, 5500));
      return reply.status(504).send({ error: 'GATEWAY_TIMEOUT' });
    }

    if (chaosConfig.failureMode === 'PHANTOM_CREATION') {
      // Record IS created in EHR, but the response socket drops/times out (Option B simulation!)
      const extId = `EHR-APPT-${crypto.randomUUID().slice(0, 8)}`;
      const appt: EhrAppointment = {
        id: extId,
        internalAppointmentId: body.internalAppointmentId,
        externalPatientId: body.externalPatientId,
        externalProviderId: body.externalProviderId,
        startTime: body.startTime,
        endTime: body.endTime,
        status: 'CONFIRMED',
        reason: body.reason,
        createdAt: new Date().toISOString(),
      };
      ehrAppointments.set(extId, appt);

      // Delay to simulate dropped response
      await new Promise((resolve) => setTimeout(resolve, 5500));
      return reply.status(504).send({ error: 'DROPPED_CONNECTION_AFTER_CREATION' });
    }

    // Normal Happy Path Creation
    const extId = `EHR-APPT-${crypto.randomUUID().slice(0, 8)}`;
    const appt: EhrAppointment = {
      id: extId,
      internalAppointmentId: body.internalAppointmentId,
      externalPatientId: body.externalPatientId,
      externalProviderId: body.externalProviderId,
      startTime: body.startTime,
      endTime: body.endTime,
      status: 'CONFIRMED',
      reason: body.reason,
      createdAt: new Date().toISOString(),
    };
    ehrAppointments.set(extId, appt);

    return reply.status(201).send(appt);
  });

  fastify.get('/api/appointments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const appt = ehrAppointments.get(id);
    if (!appt) return reply.status(404).send({ error: 'Appointment not found in EHR' });
    return appt;
  });

  fastify.get('/api/appointments/query', async (request, reply) => {
    const query = request.query as { internalId?: string };
    if (!query.internalId) return reply.status(400).send({ error: 'Missing internalId' });

    for (const appt of ehrAppointments.values()) {
      if (appt.internalAppointmentId === query.internalId) {
        return appt;
      }
    }
    return reply.status(404).send({ error: 'No matching EHR record found' });
  });

  fastify.put('/api/appointments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const appt = ehrAppointments.get(id);
    if (!appt) return reply.status(404).send({ error: 'Appointment not found in EHR' });
    const updates = request.body as Partial<EhrAppointment>;
    const updated: EhrAppointment = { ...appt, ...updates };
    ehrAppointments.set(id, updated);
    return updated;
  });

  fastify.delete('/api/appointments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Apply simulated latency if configured
    if (chaosConfig.simulatedLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, chaosConfig.simulatedLatencyMs));
    }

    // Evaluate Chaos failure modes
    if (chaosConfig.failureMode === '500_ERROR' || chaosConfig.failureMode === 'ERROR_500') {
      return reply.status(500).send({
        error: 'EHR_INTERNAL_SERVER_ERROR',
        message: 'Simulated EHR downstream database unavailable during cancellation',
      });
    }

    if (chaosConfig.failureMode === 'TIMEOUT') {
      await new Promise((resolve) => setTimeout(resolve, 5500));
      return reply.status(504).send({ error: 'GATEWAY_TIMEOUT' });
    }

    const appt = ehrAppointments.get(id);
    if (!appt) {
      return reply.status(404).send({ error: 'Appointment not found in EHR' });
    }

    appt.status = 'CANCELLED';
    ehrAppointments.set(id, appt);
    return { success: true, status: 'CANCELLED' };
  });

  const port = Number(process.env.MOCK_EHR_PORT || 4000);

  const closeHandler = async (signal: string) => {
    console.log(`Received ${signal}, closing Mock EHR Fastify gracefully...`);
    try {
      await fastify.close();
    } catch (err) {
      console.error('Error closing Mock EHR app:', err);
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => closeHandler('SIGTERM'));
  process.once('SIGINT', () => closeHandler('SIGINT'));

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`🏥 Mock EHR server listening at http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
