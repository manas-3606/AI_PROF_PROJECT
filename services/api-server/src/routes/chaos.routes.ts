import { FastifyPluginAsync } from 'fastify';

export const chaosRoutes: FastifyPluginAsync = async (fastify) => {
  const mockEhrUrl = process.env.MOCK_EHR_URL || 'http://localhost:4000';

  fastify.get('/status', async (request, reply) => {
    try {
      const res = await fetch(`${mockEhrUrl}/chaos/status`);
      const data = await res.json();
      return data;
    } catch {
      return { error: 'Mock EHR service offline' };
    }
  });

  fastify.post('/configure', async (request, reply) => {
    try {
      const res = await fetch(`${mockEhrUrl}/chaos/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const data = await res.json();
      return data;
    } catch {
      return reply.status(503).send({ error: 'Mock EHR unreachable' });
    }
  });

  fastify.post('/reset', async (request, reply) => {
    try {
      const res = await fetch(`${mockEhrUrl}/chaos/reset`, { method: 'POST' });
      const data = await res.json();
      return data;
    } catch {
      return reply.status(503).send({ error: 'Mock EHR unreachable' });
    }
  });
};
