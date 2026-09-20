import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  PatientAccessAgent,
  ConversationContextManager,
  loadSystemPrompt,
  getGeminiConfigStatus,
  testLiveGeminiConnection,
  recentLlmLogs,
} from '@health/capabilities';
import crypto from 'node:crypto';

const ChatTurnSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1),
  patientId: z.string().uuid().optional(),
  hospitalId: z.string().uuid().optional(),
});

export async function chatRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/chat/turn
   * Primary text-chat interface for the AI Patient Access Agent (PRD Section 9).
   */
  fastify.post('/turn', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = ChatTurnSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'ValidationError',
        details: parseResult.error.errors,
      });
    }

    const { conversationId = crypto.randomUUID(), message, patientId, hospitalId } =
      parseResult.data;

    const correlationId =
      (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    const agent = new PatientAccessAgent({
      conversationId,
      patientId,
      hospitalId,
      channel: 'TEXT',
    });

    const result = await agent.processTurn({
      conversationId,
      userUtterance: message,
      patientId,
      hospitalId,
      channel: 'TEXT',
      correlationId,
    });

    const matchingLog = recentLlmLogs.find((l) => l.correlationId === correlationId) || recentLlmLogs[0];

    return reply.status(200).send({
      conversationId,
      correlationId,
      userMessage: message,
      responseText: result.responseText,
      spokenText: result.spokenText,
      intentDetected: result.intentDetected,
      capabilityCalled: result.capabilityCalled,
      capabilityResult: result.capabilityResult,
      clarificationNeeded: result.clarificationNeeded || false,
      transferredToHuman: result.transferredToHuman || false,
      context: result.context,
      routeSource: matchingLog?.source || 'UNKNOWN',
      rawLog: matchingLog?.rawLog || 'No raw log captured',
    });
  });

  /**
   * GET /api/chat/debug-live-env
   * Live deployed process environment verification and end-to-end Gemini test call.
   */
  fastify.get('/debug-live-env', async (_req: FastifyRequest, reply: FastifyReply) => {
    const configStatus = getGeminiConfigStatus();
    const liveTest = await testLiveGeminiConnection();

    return reply.status(200).send({
      timestamp: new Date().toISOString(),
      service: 'api-server',
      environment: process.env.NODE_ENV || 'production',
      geminiConfig: configStatus,
      liveGeminiTest: liveTest,
    });
  });

  /**
   * GET /api/chat/debug-live-logs
   * Return recent in-memory LLM routing execution logs with raw log lines.
   */
  fastify.get('/debug-live-logs', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      timestamp: new Date().toISOString(),
      totalLogs: recentLlmLogs.length,
      logs: recentLlmLogs,
    });
  });

  /**
   * GET /api/chat/conversations/:id/context
   * Retrieve server-side persistent conversation context (PRD Section 10).
   */
  fastify.get('/conversations/:id/context', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const context = await ConversationContextManager.getContext(id);
    return reply.status(200).send({
      conversationId: id,
      context,
    });
  });

  /**
   * GET /api/chat/system-prompt
   * Inspect the active reviewable system prompt from /docs/ai/SYSTEM_PROMPT.md.
   */
  fastify.get('/system-prompt', async (request: FastifyRequest, reply: FastifyReply) => {
    const prompt = loadSystemPrompt();
    return reply.status(200).send({
      source: '/docs/ai/SYSTEM_PROMPT.md',
      systemPrompt: prompt,
    });
  });
}
