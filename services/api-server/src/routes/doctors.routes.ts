import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@health/db';
import { SlotCalculator } from '@health/scheduling';
import { HospitalOnboardingService, HospitalDoctorConfigService } from '@health/core-services';
import { UserRole, DoctorStatus } from '@health/shared-types';
import crypto from 'node:crypto';

export const doctorRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. List doctors (with optional hospitalId or specialty filter)
  fastify.get('/', async (request, reply) => {
    const query = request.query as { hospitalId?: string; specialty?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // Tenant isolation: Hospital Admin cannot query another hospital's doctors
    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && query.hospitalId && query.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: query.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'DOCTOR',
          detailsJson: JSON.stringify({
            endpoint: 'GET /api/doctors',
            actorTenantId: user.tenantId,
            targetHospitalId: query.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot view another hospital doctor roster' });
    }

    const doctors = await prisma.doctor.findMany({
      where: {
        ...(query.hospitalId ? { hospitalId: query.hospitalId } : {}),
        ...(query.specialty ? { specialty: { contains: query.specialty } } : {}),
      },
      include: { hospital: true },
    });

    return doctors.map((d) => ({
      ...d,
      languages: JSON.parse(d.languagesJson || '[]'),
      consultationTypes: JSON.parse(d.consultationTypesJson || '[]'),
    }));
  });

  // 2. Create doctor (Gated by Hospital APPROVED status and Tenant Isolation)
  fastify.post('/', async (request, reply) => {
    const body = request.body as any;
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    // Tenant check: Hospital Admin can only create doctors for their own hospital
    if (user.role === UserRole.HOSPITAL_ADMIN && user.tenantId && user.tenantId !== body.hospitalId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: body.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'DOCTOR',
          detailsJson: JSON.stringify({
            endpoint: 'POST /api/doctors',
            actorTenantId: user.tenantId,
            targetHospitalId: body.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot create doctors for another hospital' });
    }

    // Role check
    if (user.role !== UserRole.PLATFORM_ADMIN && user.role !== UserRole.HOSPITAL_ADMIN) {
      return reply.status(403).send({ error: 'Forbidden: Insufficient privileges' });
    }

    try {
      // Gated by PRD Section 5: Only APPROVED hospitals can create active doctors
      const doctor = await HospitalOnboardingService.createDoctor(
        body.hospitalId,
        {
          name: body.name,
          email: body.email,
          specialty: body.specialty,
          department: body.department,
          qualifications: body.qualifications,
          experienceYears: body.experienceYears,
          appointmentDurationMinutes: body.appointmentDurationMinutes,
        },
        correlationId
      );
      return reply.status(201).send(doctor);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 3. Get doctor by ID (Tenant isolation enforced)
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    const doctor = await prisma.doctor.findUnique({
      where: { id },
      include: {
        hospital: true,
        calendar: {
          include: { workingHours: true, blockedSlots: true },
        },
      },
    });

    if (!doctor) {
      return reply.status(404).send({ error: 'Doctor not found' });
    }

    // Tenant check: Hospital Admin cannot view doctors of other hospitals
    if (user?.role === UserRole.HOSPITAL_ADMIN && user.tenantId && doctor.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: doctor.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'DOCTOR',
          entityId: doctor.id,
          detailsJson: JSON.stringify({
            endpoint: 'GET /api/doctors/:id',
            actorTenantId: user.tenantId,
            doctorHospitalId: doctor.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden: Cannot view another hospital doctor profile' });
    }

    return {
      ...doctor,
      languages: JSON.parse(doctor.languagesJson || '[]'),
      consultationTypes: JSON.parse(doctor.consultationTypesJson || '[]'),
    };
  });

  // 4. Get available slots
  fastify.get('/:id/slots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { startDate?: string; endDate?: string };

    const startDate = query.startDate ? new Date(query.startDate) : new Date();
    const endDate = query.endDate ? new Date(query.endDate) : new Date(Date.now() + 7 * 24 * 3600 * 1000);

    const slots = await SlotCalculator.getAvailableSlots(id, startDate, endDate);
    return { slots };
  });

  // 5. Publish availability / create slots (Gated by Hospital APPROVED status and Tenant Isolation)
  fastify.post('/:id/slots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { slots } = request.body as { slots: Array<{ startTime: string; endTime: string }> };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const doctor = await prisma.doctor.findUnique({ where: { id } });
    if (!doctor) return reply.status(404).send({ error: 'Doctor not found' });

    // Tenant check
    if (user.role === UserRole.HOSPITAL_ADMIN && user.tenantId && doctor.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: doctor.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'DOCTOR',
          entityId: doctor.id,
          detailsJson: JSON.stringify({
            endpoint: 'POST /api/doctors/:id/slots',
            actorTenantId: user.tenantId,
            doctorHospitalId: doctor.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden' });
    }

    try {
      const createdSlots = await HospitalOnboardingService.publishAvailability(
        doctor.hospitalId,
        doctor.id,
        slots.map((s) => ({ startTime: new Date(s.startTime), endTime: new Date(s.endTime) })),
        correlationId
      );
      return reply.status(201).send({ slots: createdSlots });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 6. Update doctor profile (enforcing tenant isolation)
  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; appointmentDurationMinutes?: number };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // RBAC: Patient check
    if (user?.role === 'PATIENT') {
      return reply.status(403).send({ error: 'RBAC violation: Patients cannot modify doctor profiles' });
    }

    const doctor = await prisma.doctor.findUnique({ where: { id } });
    if (!doctor) return reply.status(404).send({ error: 'Doctor not found' });

    // Tenant check for Hospital Admin
    if (user?.role === 'HOSPITAL_ADMIN' && user.tenantId && doctor.hospitalId !== user.tenantId) {
      await prisma.auditEvent.create({
        data: {
          correlationId,
          hospitalId: doctor.hospitalId,
          tenantId: user.tenantId,
          actorId: user.id,
          actorRole: user.role,
          action: 'CROSS_TENANT_ACCESS_VIOLATION',
          entityType: 'DOCTOR',
          entityId: doctor.id,
          detailsJson: JSON.stringify({
            endpoint: 'PATCH /api/doctors/:id',
            actorTenantId: user.tenantId,
            doctorHospitalId: doctor.hospitalId,
          }),
        },
      });
      return reply.status(403).send({ error: 'Cross-tenant access forbidden' });
    }

    const updated = await prisma.doctor.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.appointmentDurationMinutes ? { appointmentDurationMinutes: body.appointmentDurationMinutes } : {}),
      },
    });

    return updated;
  });

  // Delete doctor (PRD Section 4 & 6: Hospital Admin or Platform Admin)
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const doctor = await prisma.doctor.findUnique({ where: { id } });
    if (!doctor) return reply.status(404).send({ error: 'Doctor not found' });

    try {
      const result = await HospitalDoctorConfigService.deleteDoctor(doctor.hospitalId, id, user, correlationId);
      return reply.send(result);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 7. Transition Doctor Status (PRD Section 6 Lifecycle: INVITED -> ACTIVE -> INACTIVE / SUSPENDED)
  fastify.post('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, reason } = request.body as { status: DoctorStatus; reason?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const doctor = await prisma.doctor.findUnique({ where: { id } });
    if (!doctor) return reply.status(404).send({ error: 'Doctor not found' });

    try {
      const updated = await HospitalDoctorConfigService.transitionDoctorStatus(
        doctor.hospitalId,
        id,
        status,
        user,
        reason,
        correlationId
      );
      return reply.send({ success: true, doctor: updated });
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 8. Doctor Calendar & Availability Config (PRD Section 4 & 6)
  fastify.get('/:id/calendar', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const calendar = await HospitalDoctorConfigService.getDoctorCalendar(id, user);
      return { calendar };
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.patch('/:id/calendar', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { isActive?: boolean; name?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const calendar = await HospitalDoctorConfigService.updateDoctorCalendar(id, body, user, correlationId);
      return reply.send({ calendar });
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 9. Working Hours Management (Editable by Hospital Admin OR Doctor for themselves)
  fastify.get('/:id/working-hours', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const workingHours = await HospitalDoctorConfigService.listWorkingHours(id, user);
      return { workingHours };
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.post('/:id/working-hours', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { dayOfWeek: number; startTime: string; endTime: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const workingHour = await HospitalDoctorConfigService.addWorkingHour(id, body, user, correlationId);
      return reply.status(201).send(workingHour);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.put('/:id/working-hours/:whId', async (request, reply) => {
    const { id, whId } = request.params as { id: string; whId: string };
    const body = request.body as { dayOfWeek?: number; startTime?: string; endTime?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalDoctorConfigService.updateWorkingHour(id, whId, body, user, correlationId);
      return reply.send(updated);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.delete('/:id/working-hours/:whId', async (request, reply) => {
    const { id, whId } = request.params as { id: string; whId: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const result = await HospitalDoctorConfigService.deleteWorkingHour(id, whId, user, correlationId);
      return reply.send(result);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 10. Blocked Periods Management (Editable by Hospital Admin OR Doctor for themselves)
  fastify.get('/:id/blocked-periods', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const blockedPeriods = await HospitalDoctorConfigService.listBlockedPeriods(id, user);
      return { blockedPeriods };
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.post('/:id/blocked-periods', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { startTime: string; endTime: string; reason?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const blockedPeriod = await HospitalDoctorConfigService.addBlockedPeriod(id, body, user, correlationId);
      return reply.status(201).send(blockedPeriod);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.put('/:id/blocked-periods/:bpId', async (request, reply) => {
    const { id, bpId } = request.params as { id: string; bpId: string };
    const body = request.body as { startTime?: string; endTime?: string; reason?: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalDoctorConfigService.updateBlockedPeriod(id, bpId, body, user, correlationId);
      return reply.send(updated);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.delete('/:id/blocked-periods/:bpId', async (request, reply) => {
    const { id, bpId } = request.params as { id: string; bpId: string };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const result = await HospitalDoctorConfigService.deleteBlockedPeriod(id, bpId, user, correlationId);
      return reply.send(result);
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // Doctor Appointment Types (PRD Section 6)
  fastify.get('/:id/appointment-types', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    try {
      const types = await HospitalDoctorConfigService.getDoctorAppointmentTypes(id, user);
      return { appointmentTypes: types };
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  fastify.put('/:id/appointment-types', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { appointmentTypes: string[] };
    const user = (request as any).user;
    const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const updated = await HospitalDoctorConfigService.updateDoctorAppointmentTypes(
        id,
        body.appointmentTypes,
        user,
        correlationId
      );
      return reply.send({ appointmentTypes: updated });
    } catch (err: any) {
      const statusCode = err.name === 'DoctorConfigUnauthorizedError' ? 403 : 400;
      return reply.status(statusCode).send({ error: err.message });
    }
  });

  // 11. Config-Time Appointment Readiness Rule Check (PRD Section 6)
  fastify.get('/:id/validate-readiness', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const doctor = await HospitalDoctorConfigService.assertDoctorReadyForAppointments(id);
      return reply.send({
        ready: true,
        doctorId: doctor.id,
        doctorName: doctor.name,
        status: doctor.status,
        calendarId: doctor.calendar?.id,
        workingHoursCount: doctor.calendar?.workingHours.length,
      });
    } catch (err: any) {
      return reply.status(400).send({
        ready: false,
        error: err.message,
        errorType: err.name,
      });
    }
  });
};
