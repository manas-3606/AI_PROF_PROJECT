import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@health/db';
import { CapabilityRegistry } from '@health/capabilities';
import { UserRole } from '@health/shared-types';
import crypto from 'node:crypto';

export const questionnaireRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const query = request.query as { hospitalId?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // Tenant isolation: Hospital Admin cannot query another hospital's questionnaires
    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && query.hospitalId && query.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: query.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'QUESTIONNAIRE',
          detailsJson: JSON.stringify({
            endpoint: 'GET /api/questionnaires',
            actorTenantId: user.tenantId,
            targetHospitalId: query.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot access questionnaires of another hospital' });
    }

    const questionnaires = await prisma.questionnaire.findMany({
      where: query.hospitalId ? { hospitalId: query.hospitalId } : undefined,
      include: {
        questions: { orderBy: { orderIndex: 'asc' } },
        hospital: true,
      },
    });

    return questionnaires.map((q) => ({
      id: q.id,
      hospitalId: q.hospitalId,
      hospitalName: q.hospital.name,
      title: q.title,
      description: q.description,
      specialty: q.specialty,
      questions: q.questions.map((qn) => ({
        id: qn.id,
        text: qn.text,
        type: qn.type,
        required: qn.required,
        options: qn.optionsJson ? JSON.parse(qn.optionsJson) : undefined,
      })),
    }));
  });

  fastify.post('/submit', async (request, reply) => {
    const body = request.body as {
      questionnaireId: string;
      appointmentId: string;
      patientId: string;
      responses: Record<string, any>;
    };

    try {
      const result = await CapabilityRegistry.execute('submit_questionnaire', body);
      return reply.status(201).send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/responses', async (request) => {
    const query = request.query as { appointmentId?: string; patientId?: string };
    const responses = await prisma.questionnaireResponse.findMany({
      where: {
        ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
        ...(query.patientId ? { patientId: query.patientId } : {}),
      },
      include: {
        questionnaire: true,
        patient: true,
      },
    });

    return responses.map((r) => ({
      ...r,
      answers: JSON.parse(r.answersJson || '{}'),
    }));
  });
};
