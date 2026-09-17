import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@health/db';
import bcrypt from 'bcrypt';
import { signToken } from '../auth.js';
import { UserRole } from '@health/shared-types';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { doctor: true, patient: true },
    });

    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const authUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
      tenantId: user.hospitalId || undefined,
      patientId: user.patient?.id,
      doctorId: user.doctor?.id,
    };

    const token = await signToken(authUser);

    return {
      token,
      user: authUser,
    };
  });

  fastify.get('/me', async (request, reply) => {
    const user = (request as any).user;
    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    return { user };
  });
};
