import { FastifyPluginAsync } from 'fastify';
import { CapabilityRegistry } from '@health/capabilities';
import crypto from 'node:crypto';

export const capabilityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/execute', async (request, reply) => {
    const { name, input, conversationId } = request.body as {
      name: string;
      input: any;
      conversationId?: string;
    };

    if (!name) {
      return reply.status(400).send({ error: 'Capability name is required' });
    }

    try {
      const user = (request as any).user;
      const result = await CapabilityRegistry.execute(
        name,
        input,
        {
          conversationId,
          correlationId: (request.headers['x-correlation-id'] as string) || crypto.randomUUID(),
          tenantId: user?.tenantId,
          actorRole: user?.role,
          actorId: user?.id,
          doctorId: user?.doctorId,
          patientId: user?.patientId,
        }
      );
      return { success: true, capability: name, result };
    } catch (err: any) {
      const isForbidden =
        err.message.includes('forbidden') ||
        err.message.includes('Access denied') ||
        err.message.includes('Cross-tenant');
      return reply.status(isForbidden ? 403 : 400).send({
        success: false,
        capability: name,
        error: err.message,
      });
    }
  });
};
