import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { PatientVoiceAgentBrain } from './agent-brain.js';
import { prisma } from '@health/db';
import crypto from 'node:crypto';

const fastify = Fastify({ logger: true });

async function start() {
  await fastify.register(cors, { origin: '*' });
  await fastify.register(websocket);

  // Health check
  fastify.get('/health', async () => ({ status: 'UP', service: 'voice-gateway' }));

  // WebSocket for Real-Time Web Voice HUD
  fastify.register(async function (fastify) {
    fastify.get('/ws/voice', { websocket: true }, (socket, req) => {
      const url = new URL(req.url, 'http://localhost');
      const queryConvId = url.searchParams.get('conversationId');
      let conversationId = queryConvId || crypto.randomUUID();
      console.log(`🎙️ Voice session opened: ${conversationId}`);

      // Ensure AI Conversation record exists in database
      prisma.aiConversation.upsert({
        where: { id: conversationId },
        update: { lastActivity: new Date(), channel: 'web_voice' },
        create: {
          id: conversationId,
          channel: 'web_voice',
        },
      }).catch((e) => console.error('Error logging aiConversation:', e));

      let brain = new PatientVoiceAgentBrain(conversationId);
      let activeTurnAbortController: AbortController | null = null;

      socket.on('message', async (rawMessage: Buffer) => {
        try {
          const parsed = JSON.parse(rawMessage.toString());

          // Handle Barge-in / Interrupt frame
          if (parsed.type === 'INTERRUPT') {
            console.log(`⚡ Patient Barge-in / INTERRUPT signal received for session ${conversationId}`);
            if (activeTurnAbortController) {
              activeTurnAbortController.abort();
              activeTurnAbortController = null;
            }
            return socket.send(JSON.stringify({ type: 'INTERRUPT_ACK', conversationId }));
          }

          // Handle Session Resume
          if (parsed.type === 'RESUME_SESSION' && parsed.conversationId) {
            conversationId = parsed.conversationId;
            brain = new PatientVoiceAgentBrain(conversationId);
            const context = await prisma.aiContext.findUnique({ where: { conversationId } });
            console.log(`🔄 Resuming existing voice session: ${conversationId}`);
            return socket.send(JSON.stringify({
              type: 'SESSION_RESTORED',
              conversationId,
              context: context ? JSON.parse(context.contextJson || '{}') : {},
            }));
          }

          const utterance = parsed.text || parsed.transcript;

          if (!utterance) {
            return socket.send(JSON.stringify({ type: 'PONG' }));
          }

          console.log(`🗣️ Patient [${conversationId}]: "${utterance}"`);
          const turnStartTime = Date.now();

          // Abort any previous pending turn
          if (activeTurnAbortController) {
            activeTurnAbortController.abort();
          }
          const abortCtrl = new AbortController();
          activeTurnAbortController = abortCtrl;

          // Filler timer: if processing takes > 800ms, stream a conversational filler to eliminate dead air
          let turnCompleted = false;
          const fillerTimeout = setTimeout(() => {
            if (!turnCompleted && !abortCtrl.signal.aborted) {
              console.log(`⏱️ Tool execution > 800ms, emitting filler utterance for [${conversationId}]`);
              socket.send(JSON.stringify({
                type: 'AGENT_FILLER',
                conversationId,
                fillerText: 'One moment, checking that with our hospital scheduling system...',
                elapsedMs: Date.now() - turnStartTime,
              }));
            }
          }, 800);

          try {
            const response = await brain.processTurn(utterance);
            turnCompleted = true;
            clearTimeout(fillerTimeout);

            if (abortCtrl.signal.aborted) {
              console.log(`⚠️ Turn execution for [${conversationId}] discarded due to interrupt.`);
              return;
            }

            const latencyMs = Date.now() - turnStartTime;
            console.log(`🤖 Agent turn completed in ${latencyMs}ms for [${conversationId}]`);

            socket.send(
              JSON.stringify({
                type: 'AGENT_TURN',
                conversationId,
                latencyMs,
                ...response,
              })
            );
          } finally {
            clearTimeout(fillerTimeout);
            if (activeTurnAbortController === abortCtrl) {
              activeTurnAbortController = null;
            }
          }
        } catch (err: any) {
          console.error('Error in voice session:', err);
          socket.send(
            JSON.stringify({
              type: 'ERROR',
              error: err.message,
            })
          );
        }
      });

      socket.on('close', async () => {
        console.log(`🔌 Voice session closed/disconnected: ${conversationId}`);
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
            console.log(`💾 Voice session context preserved safely on disconnect for [${conversationId}]`);
          }
        } catch (err) {
          console.error('Error updating disconnect state:', err);
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

  const port = Number(process.env.VOICE_GATEWAY_PORT || 3002);
  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`🎙️ Voice Gateway listening at http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
