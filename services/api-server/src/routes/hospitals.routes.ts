import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@health/db';
import { HospitalOnboardingService, HospitalDoctorConfigService } from '@health/core-services';
import { UserRole } from '@health/shared-types';
import crypto from 'node:crypto';

export const hospitalRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. List hospitals (with optional status filter)
  fastify.get('/', async (request) => {
    const query = request.query as { status?: string };
    const hospitals = await prisma.hospital.findMany({
      where: query.status ? { status: query.status } : undefined,
      include: {
        _count: {
          select: { doctors: true, appointments: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return hospitals.map((h) => ({
      ...h,
      specialties: JSON.parse(h.specialtiesJson || '[]'),
    }));
  });

  // 2. Self-service hospital registration (PRD Section 5)
  fastify.post('/', async (request, reply) => {
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    const body = request.body as any;

    try {
      const result = await HospitalOnboardingService.registerHospital(
        {
          name: body.name,
          slug: body.slug,
          address: body.address,
          city: body.city,
          operatingHours: body.operatingHours,
          contactEmail: body.contactEmail,
          contactPhone: body.contactPhone,
          specialties: body.specialties || [],
          adminUser: body.adminUser,
        },
        correlationId
      );
      return reply.status(201).send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 3. Get single hospital by ID (enforcing tenant isolation for Hospital Admin)
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // Enforce Tenant Isolation for Hospital Admins
    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && user.tenantId !== id) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: id,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'HOSPITAL',
          entityId: id,
          detailsJson: JSON.stringify({
            endpoint: 'GET /api/hospitals/:id',
            actorTenantId: user.tenantId,
            targetHospitalId: id,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot view another hospital details' });
    }

    const hospital = await prisma.hospital.findUnique({
      where: { id },
      include: {
        doctors: true,
        departments: true,
        integrations: true,
      },
    });

    if (!hospital) {
      return reply.status(404).send({ error: 'Hospital not found' });
    }

    return {
      ...hospital,
      specialties: JSON.parse(hospital.specialtiesJson || '[]'),
    };
  });

  // 4. Update hospital details (enforcing tenant isolation)
  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    const body = request.body as any;

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    // Tenant check: Hospital Admin cannot update other hospitals
    if (user.role === UserRole.HOSPITAL_ADMIN && user.tenantId && user.tenantId !== id) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: id,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'HOSPITAL',
          entityId: id,
          detailsJson: JSON.stringify({
            endpoint: 'PATCH /api/hospitals/:id',
            actorTenantId: user.tenantId,
            targetHospitalId: id,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot update another hospital' });
    }

    // Role check: Only Platform Admin or Hospital Admin for this hospital can update
    if (user.role !== UserRole.PLATFORM_ADMIN && user.role !== UserRole.HOSPITAL_ADMIN) {
      return reply.status(403).send({ error: 'Forbidden: Insufficient privileges' });
    }

    const updated = await prisma.hospital.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.address ? { address: body.address } : {}),
        ...(body.city ? { city: body.city } : {}),
        ...(body.operatingHours ? { operatingHours: body.operatingHours } : {}),
        ...(body.contactEmail ? { contactEmail: body.contactEmail } : {}),
        ...(body.contactPhone ? { contactPhone: body.contactPhone } : {}),
        ...(body.specialties ? { specialtiesJson: JSON.stringify(body.specialties) } : {}),
      },
    });

    return updated;
  });

  // 5. Lifecycle Transition: DRAFT -> SUBMITTED
  fastify.post('/:id/submit', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalOnboardingService.submitForReview(id, user, correlationId);
      return reply.send({ success: true, hospital: updated });
    } catch (err: any) {
      const statusCode = err.message.includes('Forbidden') ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 6. Lifecycle Transition: SUBMITTED -> UNDER_REVIEW (Platform Admin ONLY)
  fastify.post('/:id/review', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalOnboardingService.startReview(id, user, correlationId);
      return reply.send({ success: true, hospital: updated });
    } catch (err: any) {
      const statusCode = err.message.includes('Forbidden') ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 7. Lifecycle Transition: SUBMITTED/UNDER_REVIEW -> APPROVED (Platform Admin ONLY)
  fastify.post('/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    const { notes } = (request.body as { notes?: string }) || {};

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalOnboardingService.approveHospital(id, user, notes, correlationId);
      return reply.send({ success: true, hospital: updated });
    } catch (err: any) {
      const statusCode = err.message.includes('Forbidden') ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 8. Lifecycle Transition: SUBMITTED/UNDER_REVIEW -> REJECTED (Platform Admin ONLY)
  fastify.post('/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    const { reason } = (request.body as { reason: string }) || { reason: 'Application criteria not met' };

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalOnboardingService.rejectHospital(id, user, reason, correlationId);
      return reply.send({ success: true, hospital: updated });
    } catch (err: any) {
      const statusCode = err.message.includes('Forbidden') ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 9. Lifecycle Transition: APPROVED -> SUSPENDED (Platform Admin ONLY)
  fastify.post('/:id/suspend', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
    const { reason } = (request.body as { reason: string }) || { reason: 'Administrative suspension' };

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalOnboardingService.suspendHospital(id, user, reason, correlationId);
      return reply.send({ success: true, hospital: updated });
    } catch (err: any) {
      const statusCode = err.message.includes('Forbidden') ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 10. Lifecycle Transition: SUSPENDED -> APPROVED (Reactivate, Platform Admin ONLY)
  fastify.post('/:id/reactivate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalOnboardingService.reactivateHospital(id, user, correlationId);
      return reply.send({ success: true, hospital: updated });
    } catch (err: any) {
      const statusCode = err.message.includes('Forbidden') ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 11. Departments CRUD (PRD Section 6)
  fastify.get('/:id/departments', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    try {
      const departments = await HospitalDoctorConfigService.listDepartments(id, user);
      return { departments };
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.post('/:id/departments', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name: string; description?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const department = await HospitalDoctorConfigService.createDepartment(id, body, user, correlationId);
      return reply.status(201).send(department);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.put('/:id/departments/:deptId', async (request, reply) => {
    const { id, deptId } = request.params as { id: string; deptId: string };
    const body = request.body as { name?: string; description?: string };
    const user = (request as any).user;

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalDoctorConfigService.updateDepartment(id, deptId, body, user);
      return reply.send(updated);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.delete('/:id/departments/:deptId', async (request, reply) => {
    const { id, deptId } = request.params as { id: string; deptId: string };
    const user = (request as any).user;

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const deleted = await HospitalDoctorConfigService.deleteDepartment(id, deptId, user);
      return reply.send(deleted);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 12. Hospital Specialties CRUD (PRD Section 6)
  fastify.get('/:id/specialties', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    try {
      const specialties = await HospitalDoctorConfigService.listHospitalSpecialties(id, user);
      return reply.send(specialties);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.post('/:id/specialties', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { specialty } = request.body as { specialty: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const result = await HospitalDoctorConfigService.addHospitalSpecialty(id, specialty, user, correlationId);
      return reply.status(201).send(result);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.delete('/:id/specialties/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const result = await HospitalDoctorConfigService.removeHospitalSpecialty(id, decodeURIComponent(name), user, correlationId);
      return reply.send(result);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 13. Hospital Appointment Types (PRD Section 6)
  fastify.get('/:id/appointment-types', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    try {
      const appointmentTypes = await HospitalDoctorConfigService.listHospitalAppointmentTypes(id, user);
      return reply.send({ appointmentTypes });
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 12. Doctor Invitation / Provisioning (PRD Section 6)
  fastify.post('/:id/doctors/invite', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const result = await HospitalDoctorConfigService.inviteDoctor(id, body, user, correlationId);
      return reply.status(201).send(result);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });
};
