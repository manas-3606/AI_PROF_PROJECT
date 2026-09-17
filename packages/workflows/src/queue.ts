import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '@health/db';
import { logger } from '@health/observability';
import EventEmitter from 'node:events';

export interface WorkflowJobData {
  workflowExecutionId: string;
  workflowType:
    | 'PreVisitQuestionnaire'
    | 'AppointmentReminder'
    | 'ReconciliationSync'
    | 'AppointmentConfirmed'
    | 'EhrOperation'
    | 'QuestionnaireSubmitted';
  appointmentId?: string;
  hospitalId: string;
  payload: Record<string, any>;
  correlationId?: string;
  condition?: string;
  maxAttempts?: number;
  attemptCount?: number;
}

class InProcessWorkflowEngine extends EventEmitter {
  async dispatchJob(data: WorkflowJobData, delayMs: number = 0) {
    logger.info({ data, delayMs }, 'Dispatching workflow job to in-process queue');

    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.emit('process', data);
      }, delayMs);
      timer.unref();
    } else {
      setImmediate(() => {
        this.emit('process', data);
      });
    }
  }

  // Fast-forward simulation: execute job immediately without waiting for physical time
  async simulateExecute(data: WorkflowJobData) {
    logger.info({ data }, 'Fast-forward simulated execution for workflow job');
    this.emit('process', data);
  }
}

export const inProcessWorkflowEngine = new InProcessWorkflowEngine();

export class WorkflowQueueManager {
  private static redisUrl = process.env.REDIS_URL;
  private static bullQueue: Queue | null = null;

  static getQueue(): Queue | null {
    if (this.redisUrl && !this.bullQueue) {
      try {
        this.bullQueue = new Queue('healthcare-workflows', {
          connection: { url: this.redisUrl },
        });
      } catch (err) {
        logger.warn({ err }, 'Could not connect to Redis, falling back to in-process engine');
        this.bullQueue = null;
      }
    }
    return this.bullQueue;
  }

  static async enqueue(
    jobData: WorkflowJobData,
    options: { delayMs?: number; jobId?: string } = {}
  ): Promise<string> {
    const queue = this.getQueue();

    // 1. Resolve or create a valid Workflow parent record
    let targetWorkflow = await prisma.workflow.findFirst({
      where: {
        type: jobData.workflowType,
        ...(jobData.hospitalId && jobData.hospitalId !== 'SYSTEM' ? { hospitalId: jobData.hospitalId } : {}),
      },
    });

    if (!targetWorkflow) {
      const hospital = await prisma.hospital.findFirst();
      if (hospital) {
        targetWorkflow = await prisma.workflow.create({
          data: {
            hospitalId: hospital.id,
            type: jobData.workflowType,
            triggerEvent: 'APPOINTMENT_BOOKED',
          },
        });
      }
    }

    if (!targetWorkflow) {
      logger.warn({ jobData }, 'Cannot create WorkflowExecution without valid Workflow parent');
      return jobData.workflowExecutionId;
    }

    // Record execution in database
    const execution = await prisma.workflowExecution.create({
      data: {
        id: jobData.workflowExecutionId,
        workflowId: targetWorkflow.id,
        appointmentId: jobData.appointmentId,
        status: options.delayMs ? 'Scheduled' : 'Active',
        payloadJson: JSON.stringify(jobData.payload),
        scheduledAt: new Date(Date.now() + (options.delayMs || 0)),
      },
    });

    if (queue) {
      const job = await queue.add(jobData.workflowType, jobData, {
        delay: options.delayMs || 0,
        jobId: options.jobId || jobData.workflowExecutionId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
      return job.id || execution.id;
    }

    // In-process fallback
    await inProcessWorkflowEngine.dispatchJob(jobData, options.delayMs || 0);
    return execution.id;
  }
}
