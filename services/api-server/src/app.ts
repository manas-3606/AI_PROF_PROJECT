import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

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

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  /*
   * Render runs the API package from:
   * services/api-server
   *
   * Therefore we resolve the frontend relative to this compiled file.
   *
   * Compiled file:
   * services/api-server/dist/app.js
   *
   * Frontend:
   * apps/web/dist
   */
  const webDistPath = path.resolve(
    __dirname,
    '../../../apps/web/dist'
  );

  console.log('🌐 Frontend dist path:', webDistPath);
  console.log(
    '🌐 Frontend dist exists:',
    fs.existsSync(webDistPath)
  );
  console.log(
    '🌐 Frontend index exists:',
    fs.existsSync(path.join(webDistPath, 'index.html'))
  );

  await fastify.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    index: 'index.html',
  });

  const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL
        .split(',')
        .map((u) => u.trim().replace(/\/$/, ''))
    : ['http://localhost:5173'];

  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        return cb(null, true);
      }

      const normalizedOrigin = origin.replace(/\/$/, '');

      if (
        allowedOrigins.includes(normalizedOrigin) ||
        allowedOrigins.includes('*') ||
        (process.env.NODE_ENV !== 'production' &&
          normalizedOrigin.includes('localhost'))
      ) {
        return cb(null, true);
      }

      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string, done) => {
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
    }
  );

  fastify.addHook('onRequest', async (request, reply) => {
    const correlationId =
      (request.headers['x-correlation-id'] as string) ||
      crypto.randomUUID();

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

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'api-server',
  }));

  await fastify.register(authRoutes, {
    prefix: '/api/auth',
  });

  await fastify.register(hospitalRoutes, {
    prefix: '/api/hospitals',
  });

  await fastify.register(doctorRoutes, {
    prefix: '/api/doctors',
  });

  await fastify.register(appointmentRoutes, {
    prefix: '/api/appointments',
  });

  await fastify.register(questionnaireRoutes, {
    prefix: '/api/questionnaires',
  });

  await fastify.register(capabilityRoutes, {
    prefix: '/api/capabilities',
  });

  await fastify.register(analyticsRoutes, {
    prefix: '/api/analytics',
  });

  await fastify.register(chaosRoutes, {
    prefix: '/api/chaos',
  });

  await fastify.register(chatRoutes, {
    prefix: '/api/chat',
  });

  /*
   * SPA fallback.
   *
   * API routes should return JSON 404s.
   * Everything else should load React's index.html.
   */
  fastify.setNotFoundHandler((request, reply) => {
    const url = request.raw.url || '';

    if (url.startsWith('/api/') || url === '/health') {
      return reply.code(404).send({
        error: 'Not Found',
      });
    }

    const indexPath = path.join(webDistPath, 'index.html');

    if (!fs.existsSync(indexPath)) {
      return reply.code(500).send({
        error: 'Frontend build not found',
        frontendPath: webDistPath,
        indexPath,
      });
    }

    return reply.sendFile('index.html');
  });

  return fastify;
}