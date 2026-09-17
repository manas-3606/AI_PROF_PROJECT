import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { prisma } from '@health/db';
import { AppointmentStatus, WorkflowType } from '@health/shared-types';
import { processWorkflowJob, WorkflowJobData, inProcessWorkflowEngine } from '@health/workflows';
import crypto from 'node:crypto';

describe('Unit Test: Workflow Conditions & Async Job Execution (PRD Section 16, 17, 26)', () => {
  let hospital: any;
  let doctor: any;
  let patient: any;
  let slot: any;
  let confirmedAppt: any;
  let cancelledAppt: any;

  before(async () => {
    hospital = await prisma.hospital.findFirst({ where: { slug: 'apex-regional' } });
    assert.ok(hospital);

    doctor = await prisma.doctor.findFirst({ where: { hospitalId: hospital.id } });
    assert.ok(doctor);

    patient = await prisma.patient.findFirst();
    assert.ok(patient);

    slot = await prisma.slot.create({
      data: {
        doctorId: doctor.id,
        hospitalId: hospital.id,
        startTime: new Date(Date.now() + 86400000),
        endTime: new Date(Date.now() + 86400000 + 1800000),
        isBooked: true,
      },
    });

    confirmedAppt = await prisma.appointment.create({
      data: {
        hospitalId: hospital.id,
        doctorId: doctor.id,
        patientId: patient.id,
        slotId: slot.id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: AppointmentStatus.CONFIRMED,
        reason: 'Workflow condition test - active',
      },
    });

    cancelledAppt = await prisma.appointment.create({
      data: {
        hospitalId: hospital.id,
        doctorId: doctor.id,
        patientId: patient.id,
        slotId: slot.id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: AppointmentStatus.CANCELLED,
        reason: 'Workflow condition test - cancelled',
      },
    });
  });

  it('1. APPOINTMENT_NOT_CANCELLED allows job to proceed when appointment is Confirmed', async () => {
    // Ensure workflow record exists
    let wf = await prisma.workflow.findFirst({ where: { type: WorkflowType.APPOINTMENT_REMINDER } });
    if (!wf) {
      wf = await prisma.workflow.create({
        data: {
          hospitalId: hospital.id,
          name: 'Reminder Flow',
          type: WorkflowType.APPOINTMENT_REMINDER,
          triggerEvent: 'APPOINTMENT_CONFIRMED',
          configJson: JSON.stringify({ leadHours: 24 }),
        },
      });
    }

    const exec = await prisma.workflowExecution.create({
      data: {
        workflowId: wf.id,
        hospitalId: hospital.id,
        status: 'Scheduled',
        payloadJson: JSON.stringify({ appointmentId: confirmedAppt.id }),
      },
    });

    const jobData: WorkflowJobData = {
      workflowExecutionId: exec.id,
      workflowType: 'AppointmentReminder',
      hospitalId: hospital.id,
      appointmentId: confirmedAppt.id,
      condition: 'APPOINTMENT_NOT_CANCELLED',
      payload: {
        appointmentId: confirmedAppt.id,
        doctorName: doctor.name,
        startTime: confirmedAppt.startTime,
      },
      attemptCount: 0,
    };

    await processWorkflowJob(jobData);

    const updatedExec = await prisma.workflowExecution.findUnique({ where: { id: exec.id } });
    assert.strictEqual(updatedExec?.status, 'Completed', 'Job must complete when appointment is active');
    assert.ok(updatedExec?.executedAt, 'Execution timestamp must be set');
  });

  it('2. APPOINTMENT_NOT_CANCELLED skips job and marks Cancelled when appointment is Cancelled', async () => {
    let wf = await prisma.workflow.findFirst({ where: { type: WorkflowType.APPOINTMENT_REMINDER } });
    assert.ok(wf);

    const exec = await prisma.workflowExecution.create({
      data: {
        workflowId: wf.id,
        hospitalId: hospital.id,
        status: 'Scheduled',
        payloadJson: JSON.stringify({ appointmentId: cancelledAppt.id }),
      },
    });

    const jobData: WorkflowJobData = {
      workflowExecutionId: exec.id,
      workflowType: 'AppointmentReminder',
      hospitalId: hospital.id,
      appointmentId: cancelledAppt.id,
      condition: 'APPOINTMENT_NOT_CANCELLED',
      payload: {
        appointmentId: cancelledAppt.id,
        doctorName: doctor.name,
        startTime: cancelledAppt.startTime,
      },
      attemptCount: 0,
    };

    await processWorkflowJob(jobData);

    const updatedExec = await prisma.workflowExecution.findUnique({ where: { id: exec.id } });
    assert.strictEqual(
      updatedExec?.status,
      'Cancelled',
      'Job must be marked Cancelled when appointment was cancelled'
    );
  });

  it('3. Increments attempt counter and records execution history', async () => {
    let wf = await prisma.workflow.findFirst({ where: { type: WorkflowType.APPOINTMENT_REMINDER } });
    assert.ok(wf);

    const exec = await prisma.workflowExecution.create({
      data: {
        workflowId: wf.id,
        hospitalId: hospital.id,
        status: 'Scheduled',
        attemptCount: 1,
        payloadJson: JSON.stringify({ appointmentId: confirmedAppt.id }),
      },
    });

    const jobData: WorkflowJobData = {
      workflowExecutionId: exec.id,
      workflowType: 'AppointmentReminder',
      hospitalId: hospital.id,
      appointmentId: confirmedAppt.id,
      condition: 'APPOINTMENT_NOT_CANCELLED',
      payload: {
        appointmentId: confirmedAppt.id,
        doctorName: doctor.name,
        startTime: confirmedAppt.startTime,
      },
      attemptCount: 1,
    };

    await processWorkflowJob(jobData);

    const updatedExec = await prisma.workflowExecution.findUnique({ where: { id: exec.id } });
    assert.strictEqual(updatedExec?.attemptCount, 2, 'Attempt counter must increment on execution');
  });
});
