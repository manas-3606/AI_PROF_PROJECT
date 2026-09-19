import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { runWithContext } from '@health/observability';
import { AuthService } from '@health/core-services';
import { authRoutes } from './routes/auth.routes.js';
import { hospitalRoutes } from './routes/hospitals.routes.js';
import { doctorRoutes } from './routes/doctors.routes.js';
import { appointmentRoutes } from './routes/appointments.routes.js';
import { questionnaireRoutes } from './routes/questionnaires.routes.js';
import { capabilityRoutes } from './routes/capabilities.routes.js';
import { analyticsRoutes } from './routes/analytics.routes.js';
import { chaosRoutes } from './routes/chaos.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import crypto from 'node:crypto';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map((u) => u.trim().replace(/\/$/, ''))
    : ['http://localhost:5173'];

  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow non-browser requests (Postman, server-to-server, curl)
      if (!origin) return cb(null, true);

      const normalizedOrigin = origin.replace(/\/$/, '');
      if (
        allowedOrigins.includes(normalizedOrigin) ||
        allowedOrigins.includes('*') ||
        (process.env.NODE_ENV !== 'production' && normalizedOrigin.includes('localhost'))
      ) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Handle empty JSON bodies gracefully without throwing FST_ERR_CTP_EMPTY_JSON_BODY
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    try {
      if (!body || !body.trim()) {
        done(null, {});
        return;
      }
      const json = JSON.parse(body);
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Request hook: extract correlation ID & auth token
  fastify.addHook('onRequest', async (request, reply) => {
    const correlationId =
      (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    reply.header('x-correlation-id', correlationId);

    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const user = await AuthService.verifyToken(token);
        (request as any).user = user;
      } catch {
        (request as any).user = null;
      }
    }
  });

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', service: 'api-server' }));

  // Register Routes
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(hospitalRoutes, { prefix: '/api/hospitals' });
  await fastify.register(doctorRoutes, { prefix: '/api/doctors' });
  await fastify.register(appointmentRoutes, { prefix: '/api/appointments' });
  await fastify.register(questionnaireRoutes, { prefix: '/api/questionnaires' });
  await fastify.register(capabilityRoutes, { prefix: '/api/capabilities' });
  await fastify.register(analyticsRoutes, { prefix: '/api/analytics' });
  await fastify.register(chaosRoutes, { prefix: '/api/chaos' });
  await fastify.register(chatRoutes, { prefix: '/api/chat' });

  return fastify;
}
