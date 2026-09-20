import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { PatientVoiceAgentBrain } from './agent-brain.js';
import { prisma } from '@health/db';
import { logger } from '@health/observability';
import crypto from 'node:crypto';

import { getGeminiConfigStatus, testLiveGeminiConnection, recentLlmLogs } from '@health/capabilities';

const fastify = Fastify({ logger: false });

// Maximum allowed capability/turn latency before emitting graceful fallback utterance (allows EHR failure-recovery & reconciliation)
const HARD_TURN_TIMEOUT_MS = 12000;

async function start() {
  await fastify.register(cors, { origin: '*' });
  await fastify.register(websocket);

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', service: 'voice-gateway' }));

  // Debug Live Environment & Logs
  fastify.get('/debug-live-env', async () => {
    const configStatus = getGeminiConfigStatus();
    const liveTest = await testLiveGeminiConnection();
    return {
      timestamp: new Date().toISOString(),
      service: 'voice-gateway',
      geminiConfig: configStatus,
      liveGeminiTest: liveTest,
    };
  });

  fastify.get('/debug-live-logs', async () => {
    return {
      timestamp: new Date().toISOString(),
      service: 'voice-gateway',
      totalLogs: recentLlmLogs.length,
      logs: recentLlmLogs,
    };
  });

  // WebSocket for Real-Time Web Voice HUD
  fastify.register(async function (fastify) {
    fastify.get('/ws/voice', { websocket: true }, (socket, req) => {
      const url = new URL(req.url, 'http://localhost');
      const queryConvId = url.searchParams.get('conversationId');
      const queryPatientId = url.searchParams.get('patientId') || undefined;
      const queryHospitalId = url.searchParams.get('hospitalId') || undefined;
      let conversationId = queryConvId || crypto.randomUUID();
      let sessionCorrelationId = `sess-${crypto.randomUUID()}`;

      logger.info(
        {
          conversationId,
          patientId: queryPatientId,
          hospitalId: queryHospitalId,
          correlationId: sessionCorrelationId,
          event: 'WS_SESSION_OPENED',
          remoteAddress: req.socket.remoteAddress,
        },
        `🎙️ Voice session opened: ${conversationId}`
      );

      // Ensure AI Conversation record exists in database
      prisma.aiConversation
        .upsert({
          where: { id: conversationId },
          update: { lastActivity: new Date(), channel: 'web_voice', patientId: queryPatientId, hospitalId: queryHospitalId },
          create: {
            id: conversationId,
            channel: 'web_voice',
            patientId: queryPatientId,
            hospitalId: queryHospitalId,
          },
        })
        .catch((e) =>
          logger.error(
            { err: e, conversationId, correlationId: sessionCorrelationId },
            'Error logging aiConversation'
          )
        );

      let brain = new PatientVoiceAgentBrain(conversationId, queryPatientId, queryHospitalId);
      let activeTurnAbortController: AbortController | null = null;

      socket.on('message', async (rawMessage: Buffer) => {
        try {
          const parsed = JSON.parse(rawMessage.toString());
          const turnCorrelationId = parsed.correlationId || `turn-${Date.now()}`;

          // 1. Client-Side Lifecycle Telemetry (AudioWorklet, VAD, TTS, etc.)
          if (parsed.type === 'CLIENT_LIFECYCLE_EVENT') {
            logger.info(
              {
                conversationId,
                correlationId: turnCorrelationId,
                event: parsed.event,
                details: parsed.details || {},
                clientTimestamp: parsed.timestamp || Date.now(),
              },
              `Client voice lifecycle event: ${parsed.event}`
            );
            return;
          }

          // 2. WebSocket Heartbeat (Keepalive ping/pong)
          if (parsed.type === 'HEARTBEAT_PING') {
            logger.debug(
              {
                conversationId,
                correlationId: turnCorrelationId,
                event: 'WS_HEARTBEAT_PING_RECEIVED',
                clientTimestamp: parsed.clientTimestamp,
              },
              'Received WebSocket heartbeat ping'
            );
            return socket.send(
              JSON.stringify({
                type: 'HEARTBEAT_PONG',
                conversationId,
                correlationId: turnCorrelationId,
                clientTimestamp: parsed.clientTimestamp,
                serverTimestamp: Date.now(),
              })
            );
          }

          // 3. Barge-in / Interrupt frame
          if (parsed.type === 'INTERRUPT') {
            logger.warn(
              {
                conversationId,
                correlationId: turnCorrelationId,
                event: 'BARGE_IN_TRIGGERED',
              },
              `⚡ Patient Barge-in / INTERRUPT signal received for session ${conversationId}`
            );
            if (activeTurnAbortController) {
              activeTurnAbortController.abort();
              activeTurnAbortController = null;
            }
            logger.info(
              {
                conversationId,
                correlationId: turnCorrelationId,
                event: 'BARGE_IN_ACK_SENT',
              },
              'Sent BARGE_IN_ACK'
            );
            return socket.send(
              JSON.stringify({
                type: 'INTERRUPT_ACK',
                conversationId,
                correlationId: turnCorrelationId,
              })
            );
          }

          // 4. Session Resume
          if (parsed.type === 'RESUME_SESSION' && parsed.conversationId) {
            conversationId = parsed.conversationId;
            brain = new PatientVoiceAgentBrain(conversationId);
            const context = await prisma.aiContext.findUnique({ where: { conversationId } });
            logger.info(
              {
                conversationId,
                correlationId: turnCorrelationId,
                event: 'SESSION_RESUMED',
              },
              `🔄 Resuming existing voice session: ${conversationId}`
            );
            return socket.send(
              JSON.stringify({
                type: 'SESSION_RESTORED',
                conversationId,
                correlationId: turnCorrelationId,
                context: context ? JSON.parse(context.contextJson || '{}') : {},
              })
            );
          }

          const utterance = parsed.text || parsed.transcript;

          if (!utterance) {
            return socket.send(
              JSON.stringify({
                type: 'PONG',
                conversationId,
                correlationId: turnCorrelationId,
              })
            );
          }

          logger.info(
            {
              conversationId,
              correlationId: turnCorrelationId,
              event: 'PATIENT_UTTERANCE_RECEIVED',
              utterance,
            },
            `🗣️ Patient [${conversationId}]: "${utterance}"`
          );
          const turnStartTime = Date.now();

          // Abort any previous pending turn
          if (activeTurnAbortController) {
            activeTurnAbortController.abort();
          }
          const abortCtrl = new AbortController();
          activeTurnAbortController = abortCtrl;

          // Conversational filler timer: if capability takes > 750ms, stream a natural filler
          let turnCompleted = false;
          const fillerTimeout = setTimeout(() => {
            if (!turnCompleted && !abortCtrl.signal.aborted) {
              logger.info(
                {
                  conversationId,
                  correlationId: turnCorrelationId,
                  event: 'AGENT_FILLER_DISPATCHED',
                  elapsedMs: Date.now() - turnStartTime,
                },
                `⏱️ Emitting filler utterance for [${conversationId}]`
              );
              socket.send(
                JSON.stringify({
                  type: 'AGENT_FILLER',
                  conversationId,
                  correlationId: turnCorrelationId,
                  fillerText: 'One moment, checking that with our hospital scheduling system...',
                  elapsedMs: Date.now() - turnStartTime,
                })
              );
            }
          }, 750);

          try {
            let isTimedOut = false;
            const turnPatientId = parsed.patientId || queryPatientId;
            const turnHospitalId = parsed.hospitalId || queryHospitalId;
            const turnPromise = brain.processTurn(utterance, turnCorrelationId, abortCtrl.signal, turnPatientId, turnHospitalId);

            // Explicit late-arrival handling: If turnPromise resolves after timeout or abort,
            // silently update context without sending duplicate or contradictory speech to patient
            turnPromise
              .then(async (lateResult) => {
                if (isTimedOut || abortCtrl.signal.aborted) {
                  logger.info(
                    {
                      conversationId,
                      correlationId: turnCorrelationId,
                      event: 'LATE_TURN_RESULT_SILENTLY_APPLIED',
                      capabilityCalled: lateResult.capabilityCalled,
                      intentDetected: lateResult.intentDetected,
                      elapsedMs: Date.now() - turnStartTime,
                    },
                    `🔄 Late-arriving capability result [${lateResult.capabilityCalled || 'turn'}] completed after timeout fallback. State preserved silently in context without speaking duplicate response to patient.`
                  );
                }
              })
              .catch((err) => {
                if (isTimedOut || abortCtrl.signal.aborted) {
                  logger.warn(
                    {
                      conversationId,
                      correlationId: turnCorrelationId,
                      event: 'LATE_TURN_PROMISE_CANCELLED_OR_FAILED',
                      err: err?.message,
                    },
                    `Late-arriving turn promise aborted or failed after timeout for [${conversationId}]`
                  );
                }
              });

            const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) =>
              setTimeout(() => resolve({ isTimeout: true }), HARD_TURN_TIMEOUT_MS)
            );

            const result = await Promise.race([turnPromise, timeoutPromise]);
            turnCompleted = true;
            clearTimeout(fillerTimeout);

            if (abortCtrl.signal.aborted) {
              logger.warn(
                {
                  conversationId,
                  correlationId: turnCorrelationId,
                  event: 'AGENT_TURN_DISCARDED_INTERRUPT',
                },
                `⚠️ Turn execution for [${conversationId}] discarded due to interrupt.`
              );
              return;
            }

            if ('isTimeout' in result) {
              isTimedOut = true;
              // Explicitly signal cancellation to in-flight capability operations
              abortCtrl.abort();

              logger.warn(
                {
                  conversationId,
                  correlationId: turnCorrelationId,
                  event: 'HARD_TURN_TIMEOUT_TRIGGERED',
                  timeoutMs: HARD_TURN_TIMEOUT_MS,
                },
                'Turn processing reached hard timeout threshold; sending graceful fallback utterance and aborting in-flight execution'
              );
              const fallbackResponse = {
                spokenText:
                  "Our hospital scheduling system is taking a few moments to synchronize. I am holding your request and checking your appointment status now.",
                intentDetected: 'TURN_TIMEOUT_FALLBACK',
                correlationId: turnCorrelationId,
              };
              return socket.send(
                JSON.stringify({
                  type: 'AGENT_TURN',
                  conversationId,
                  latencyMs: Date.now() - turnStartTime,
                  ...fallbackResponse,
                })
              );
            }

            const latencyMs = Date.now() - turnStartTime;
            logger.info(
              {
                conversationId,
                correlationId: turnCorrelationId,
                event: 'AGENT_TURN_DISPATCHED',
                latencyMs,
                spokenText: result.spokenText,
                capabilityCalled: result.capabilityCalled,
              },
              `🤖 Agent turn completed in ${latencyMs}ms for [${conversationId}]`
            );

            socket.send(
              JSON.stringify({
                type: 'AGENT_TURN',
                conversationId,
                correlationId: turnCorrelationId,
                latencyMs,
                ...result,
              })
            );
          } finally {
            clearTimeout(fillerTimeout);
            if (activeTurnAbortController === abortCtrl) {
              activeTurnAbortController = null;
            }
          }
        } catch (err: any) {
          logger.error(
            {
              err,
              conversationId,
              correlationId: sessionCorrelationId,
              event: 'ERROR_ENCOUNTERED',
            },
            'Error in voice session'
          );
          socket.send(
            JSON.stringify({
              type: 'ERROR',
              conversationId,
              correlationId: sessionCorrelationId,
              error: err.message || 'Internal voice session error',
            })
          );
        }
      });

      socket.on('close', async (code, reason) => {
        logger.info(
          {
            conversationId,
            correlationId: sessionCorrelationId,
            event: 'WS_SESSION_CLOSED',
            code,
            reason: reason?.toString(),
          },
          `🔌 Voice session closed/disconnected: ${conversationId}`
        );
        if (activeTurnAbortController) {
          activeTurnAbortController.abort();
          activeTurnAbortController = null;
        }

        // Mid-call disconnect resilience: mark context as preserved so booking state isn't lost
        try {
          const existing = await prisma.aiContext.findUnique({ where: { conversationId } });
          if (existing) {
            const extra = JSON.parse(existing.contextJson || '{}');
            extra.disconnectState = {
              disconnectedAt: new Date().toISOString(),
              status: 'PRESERVED_FOR_RESUME',
            };
            await prisma.aiContext.update({
              where: { conversationId },
              data: { contextJson: JSON.stringify(extra) },
            });
            logger.info(
              {
                conversationId,
                correlationId: sessionCorrelationId,
                event: 'DISCONNECT_STATE_PRESERVED',
              },
              `💾 Voice session context preserved safely on disconnect for [${conversationId}]`
            );
          }
        } catch (err) {
          logger.error(
            {
              err,
              conversationId,
              correlationId: sessionCorrelationId,
              event: 'DISCONNECT_PRESERVATION_ERROR',
            },
            'Error updating disconnect state'
          );
        }
      });
    });
  });

  // Telephony Webhook Adapter (Twilio Media Streams compatible)
  fastify.post('/api/telephony/inbound', async (request, reply) => {
    const callSid = (request.body as any)?.CallSid || `CALL-${crypto.randomUUID()}`;
    console.log(`📞 Inbound telephony call received: ${callSid}`);

    // Return TwiML response directing stream to WebSocket
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Welcome to the Multi-Hospital Appointment Desk. Please describe how we can assist you today.</Say>
    <Connect>
        <Stream url="wss://${request.headers.host}/ws/voice" />
    </Connect>
</Response>`;

    return reply.type('text/xml').send(twiml);
  });

  const port = Number(process.env.PORT || process.env.VOICE_GATEWAY_PORT || 3002);
  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`🎙️ Voice Gateway listening on port ${port} (host: 0.0.0.0)`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
