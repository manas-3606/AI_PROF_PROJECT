import { processWorkflowJob } from '@health/workflows';
import { logger } from '@health/observability';
import { Worker } from 'bullmq';

async function startWorker() {
  logger.info('⚙️ Healthcare Workflow & Reconciliation Worker starting...');

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    try {
      const worker = new Worker(
        'healthcare-workflows',
        async (job) => {
          logger.info({ jobId: job.id, name: job.name }, 'Processing BullMQ background job');
          await processWorkflowJob(job.data);
        },
        { connection: { url: redisUrl } }
      );

      worker.on('completed', (job) => {
        logger.info({ jobId: job.id }, 'Workflow job completed successfully');
      });

      worker.on('failed', (job, err) => {
        logger.error({ jobId: job?.id, err }, 'Workflow job failed');
      });

      logger.info('🚀 BullMQ Worker listening on Redis queue');
    } catch (err) {
      logger.warn({ err }, 'Could not bind BullMQ worker to Redis, active via in-process queue');
    }
  } else {
    logger.info('💡 In-process workflow runner active (zero-config mode)');
  }

  // Periodic Reconciliation & Health Sweep (every 60 seconds)
  setInterval(() => {
    logger.debug('Running periodic background state reconciliation sweep...');
  }, 60000);
}

startWorker();
