import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Volume2,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ShieldAlert,
  Radio,
  Send,
  Square,
} from 'lucide-react';
import { ApiService } from '../services/api.js';

interface VoiceHudProps {
  onAppointmentBooked?: () => void;
}

interface Message {
  sender: 'user' | 'agent' | 'system';
  text: string;
  capability?: string;
  transferred?: boolean;
}

export const VoiceHud: React.FC<VoiceHudProps> = ({ onAppointmentBooked }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [messages, setMessages] = useState<Message[]>([
    {
      sender: 'agent',
      text: 'Hello! I am your AI hospital access assistant. You can speak to me or type your healthcare request naturally.',
    },
  ]);
  const [inputText, setInputText] = useState('');
  const [activeCapability, setActiveCapability] = useState<string | null>(null);
  const [fillerText, setFillerText] = useState<string | null>(null);
  const [lastTurnLatency, setLastTurnLatency] = useState<number | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(() => {
    const user = ApiService.getCurrentUser();
    const key = user?.patientId ? `active_voice_conversation_id_${user.patientId}` : 'active_voice_conversation_id';
    return localStorage.getItem(key);
  });

  // Audio visualization and feedback states
  const [audioLevels, setAudioLevels] = useState<number[]>([8, 8, 8, 8, 8, 8, 8]);
  const [micVolume, setMicVolume] = useState<number>(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [isContinuousActive, setIsContinuousActive] = useState<boolean>(false);

  // Connection health & diagnostics
  const [sessionHealth, setSessionHealth] = useState<'healthy' | 'degraded' | 'disconnected'>('disconnected');
  const [rttLatency, setRttLatency] = useState<number | null>(null);

  // References
  const wsRef = useRef<WebSocket | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const isRecognizingRef = useRef<boolean>(false);
  const voiceStateRef = useRef<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const isContinuousSessionRef = useRef<boolean>(false);
  const startListeningRef = useRef<() => void>(() => {});
  const accumulatedTranscriptRef = useRef<string>('');
  const silenceTimerRef = useRef<any>(null);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const heartbeatTimerRef = useRef<any>(null);
  const lastPongTimeRef = useRef<number>(Date.now());
  const speechStartTimeRef = useRef<number | null>(null);

  const onAppointmentBookedRef = useRef(onAppointmentBooked);
  useEffect(() => {
    onAppointmentBookedRef.current = onAppointmentBooked;
  }, [onAppointmentBooked]);

  // Web Audio API refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const isStartingRef = useRef<boolean>(false);
  const isStoppingRef = useRef<boolean>(false);
  const reconnectTimerRef = useRef<any>(null);
  const isConnectingRef = useRef<boolean>(false);

  // Helper to emit structured client lifecycle telemetry to server
  const sendLifecycleEvent = useCallback((event: string, details?: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'CLIENT_LIFECYCLE_EVENT',
          event,
          details,
          timestamp: Date.now(),
        })
      );
    }
  }, []);

  // Keep ref synchronized with state
  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopAudioCapture();
      if (recognitionRef.current && isRecognizingRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
      if (wsRef.current) wsRef.current.close();
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  // Auto-scroll chat transcript internally ONLY when new messages arrive (never scrolls window)
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages]);

  // Web Audio API microphone stream capture
  const startAudioCapture = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateMeter = () => {
        if (!analyserRef.current || voiceStateRef.current !== 'listening') return;

        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const normalizedVol = Math.min(100, Math.round((average / 128) * 100));
        setMicVolume(normalizedVol);

        const bands = [
          dataArray[1] || 8,
          dataArray[3] || 8,
          dataArray[5] || 8,
          dataArray[7] || 8,
          dataArray[9] || 8,
          dataArray[12] || 8,
          dataArray[15] || 8,
        ];

        const mappedBars = bands.map((val) => Math.max(6, Math.min(48, Math.round((val / 255) * 48))));
        setAudioLevels(mappedBars);

        animFrameRef.current = requestAnimationFrame(updateMeter);
      };

      animFrameRef.current = requestAnimationFrame(updateMeter);
    } catch (err: any) {
      console.warn('Microphone audio capture warning:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setMicError('Microphone permission was denied. Please allow microphone access in your browser settings.');
      }
    }
  };

  // Stop audio capture cleanly
  const stopAudioCapture = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setMicVolume(0);
    setAudioLevels([6, 6, 6, 6, 6, 6, 6]);
  };

  // Synthetic animation while agent is speaking
  useEffect(() => {
    let interval: any = null;
    if (voiceState === 'speaking') {
      interval = setInterval(() => {
        setAudioLevels([
          Math.floor(12 + Math.random() * 24),
          Math.floor(18 + Math.random() * 26),
          Math.floor(22 + Math.random() * 24),
          Math.floor(26 + Math.random() * 22),
          Math.floor(20 + Math.random() * 24),
          Math.floor(16 + Math.random() * 20),
          Math.floor(10 + Math.random() * 16),
        ]);
      }, 90);
    } else if (voiceState !== 'listening') {
      setAudioLevels([6, 6, 6, 6, 6, 6, 6]);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [voiceState]);

  // Barge-in: immediately cancel active TTS speech and send interrupt frame
  const cancelSpeechAndBargeIn = useCallback(() => {
    sendLifecycleEvent('BARGE_IN_TRIGGERED');
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      console.log('⚡ Barge-in triggered: Cancelling active TTS speech.');
      window.speechSynthesis.cancel();
      activeUtteranceRef.current = null;
    }
    // Prevent stuck speaking state lock
    setVoiceState('idle');
    voiceStateRef.current = 'idle';
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'INTERRUPT' }));
    }
  }, [sendLifecycleEvent]);

  // Send completed patient utterance to AI voice gateway
  const handlePatientUtterance = useCallback((textToSend: string) => {
    const cleaned = textToSend.trim();
    if (!cleaned) return;

    // Barge-in: cancel any existing TTS
    cancelSpeechAndBargeIn();

    // Stop listening while turn is processing to avoid echo
    if (recognitionRef.current && isRecognizingRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
      isRecognizingRef.current = false;
    }
    stopAudioCapture();
    accumulatedTranscriptRef.current = '';
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    setMessages((prev) => [...prev, { sender: 'user', text: cleaned }]);
    setVoiceState('thinking');
    setFillerText(null);
    setInputText('');

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const currentUser = ApiService.getCurrentUser();
      wsRef.current.send(
        JSON.stringify({
          text: cleaned,
          patientId: currentUser?.patientId,
          hospitalId: currentUser?.hospitalId,
        })
      );
    } else {
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            sender: 'system',
            text: 'Voice gateway is connecting. Please ensure the voice-gateway service is running and reachable.',
          },
        ]);
        setVoiceState('idle');
      }, 1000);
    }
  }, [cancelSpeechAndBargeIn]);

  // Initialize Speech Recognition
  const setupSpeechRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      // Do not process microphone input while the agent is speaking (echo prevention)
      if (voiceStateRef.current === 'speaking') {
        return;
      }

      let currentFinal = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const item = event.results[i];
        if (item.isFinal) {
          currentFinal += item[0].transcript + ' ';
        } else {
          currentFinal += item[0].transcript;
        }
      }

      const text = currentFinal.trim();
      if (!text) return;

      if (!speechStartTimeRef.current) {
        speechStartTimeRef.current = Date.now();
        sendLifecycleEvent('VAD_SPEECH_START', { initialText: text });
      }

      accumulatedTranscriptRef.current = text;

      // Auto-submit after 1400ms of user silence once speech is recognized (optimal balance: sub-2s latency + pause tolerance)
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      silenceTimerRef.current = setTimeout(() => {
        if (voiceStateRef.current === 'listening' && accumulatedTranscriptRef.current.trim()) {
          const durationMs = speechStartTimeRef.current ? Date.now() - speechStartTimeRef.current : 0;
          sendLifecycleEvent('VAD_SPEECH_END', {
            transcript: accumulatedTranscriptRef.current,
            durationMs,
            silenceThresholdMs: 1400,
          });
          speechStartTimeRef.current = null;
          console.log('🎙️ Silence detected (1400ms threshold), auto-submitting:', accumulatedTranscriptRef.current);
          handlePatientUtterance(accumulatedTranscriptRef.current);
        }
      }, 1400);
    };

    recognition.onstart = () => {
      isRecognizingRef.current = true;
      isStartingRef.current = false;
      sendLifecycleEvent('SPEECH_RECOGNITION_ONSTART');
    };

    recognition.onerror = (e: any) => {
      sendLifecycleEvent('SPEECH_RECOGNITION_ERROR', { error: e.error });
      isRecognizingRef.current = false;
      isStartingRef.current = false;
      if (e.error === 'not-allowed') {
        setMicError('Microphone permission was denied. Please allow microphone access in browser settings.');
        setVoiceState('idle');
        stopAudioCapture();
      } else if (e.error === 'network') {
        setMicError('Speech recognition service offline (network issue). You can type directly in the box below or click to retry.');
        setVoiceState('idle');
        stopAudioCapture();
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('Speech recognition error:', e.error);
        setMicError(`Microphone issue: ${e.error}`);
        setVoiceState('idle');
        stopAudioCapture();
      }
    };

    recognition.onend = () => {
      isRecognizingRef.current = false;
      isStartingRef.current = false;
      sendLifecycleEvent('SPEECH_RECOGNITION_ONEND', {
        voiceState: voiceStateRef.current,
        hasAccumulatedText: !!accumulatedTranscriptRef.current.trim(),
      });
      if (isStoppingRef.current) {
        return;
      }
      if (voiceStateRef.current === 'listening') {
        if (accumulatedTranscriptRef.current.trim()) {
          handlePatientUtterance(accumulatedTranscriptRef.current);
        } else if (isContinuousSessionRef.current) {
          // Restart cleanly if user remains in continuous hands-free listening
          setTimeout(() => {
            if (isContinuousSessionRef.current && voiceStateRef.current === 'listening' && !isStoppingRef.current && !isRecognizingRef.current) {
              try {
                isStartingRef.current = true;
                recognition.start();
              } catch {
                isStartingRef.current = false;
              }
            }
          }, 80);
        }
      }
    };

    return recognition;
  }, [handlePatientUtterance, sendLifecycleEvent]);

  // Text-to-Speech playback with microphone loopback protection
  const speakText = useCallback((text: string) => {
    if (!('speechSynthesis' in window)) return;

    sendLifecycleEvent('TTS_PLAYBACK_REQUESTED', { textLength: text.length });

    // Echo prevention: mute and abort microphone before computer speaks
    if (recognitionRef.current && isRecognizingRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
      isRecognizingRef.current = false;
    }
    stopAudioCapture();
    accumulatedTranscriptRef.current = '';

    window.speechSynthesis.cancel();
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    activeUtteranceRef.current = utterance;

    // Safety watchdog: Chrome sometimes drops utterance.onend on long speech strings
    const estimatedDurationMs = Math.max(3500, Math.min(15000, (text.length / 14) * 1000 + 1000));
    const safetyTimer = setTimeout(() => {
      if (activeUtteranceRef.current === utterance && voiceStateRef.current === 'speaking') {
        console.warn('TTS safety watchdog fired: releasing speaking lock');
        activeUtteranceRef.current = null;
        if (isContinuousSessionRef.current) {
          setVoiceState('listening');
          startListeningRef.current();
        } else {
          setVoiceState('idle');
        }
      }
    }, estimatedDurationMs);

    utterance.onstart = () => {
      setVoiceState('speaking');
      sendLifecycleEvent('TTS_PLAYBACK_START');
    };

    utterance.onend = () => {
      clearTimeout(safetyTimer);
      activeUtteranceRef.current = null;
      sendLifecycleEvent('TTS_PLAYBACK_END');
      if (isContinuousSessionRef.current) {
        setVoiceState('listening');
        setTimeout(() => {
          if (isContinuousSessionRef.current) {
            startListeningRef.current();
          }
        }, 350);
      } else {
        setVoiceState('idle');
      }
    };

    utterance.onerror = (err) => {
      clearTimeout(safetyTimer);
      console.warn('TTS playback ended/error:', err);
      activeUtteranceRef.current = null;
      sendLifecycleEvent('TTS_PLAYBACK_ERROR', { error: String(err) });
      if (isContinuousSessionRef.current) {
        setVoiceState('listening');
        setTimeout(() => {
          if (isContinuousSessionRef.current) {
            startListeningRef.current();
          }
        }, 350);
      } else {
        setVoiceState('idle');
      }
    };

    window.speechSynthesis.speak(utterance);
  }, [sendLifecycleEvent]);

  // Connect WebSocket to Voice Gateway with Heartbeat & Error recovery
  const connectWebSocket = useCallback(() => {
    try {
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      const currentUser = ApiService.getCurrentUser();
      const patientId = currentUser?.patientId || '';
      const hospitalId = currentUser?.hospitalId || '';
      const storageKey = patientId ? `active_voice_conversation_id_${patientId}` : 'active_voice_conversation_id';
      const savedId = localStorage.getItem(storageKey);

      const queryParams = new URLSearchParams();
      if (savedId) queryParams.set('conversationId', savedId);
      if (patientId) queryParams.set('patientId', patientId);
      if (hospitalId) queryParams.set('hospitalId', hospitalId);

      const qs = queryParams.toString();
      const configuredWs = import.meta.env.VITE_VOICE_GATEWAY_WS_URL?.trim();
      let baseWs =
        configuredWs ||
        (import.meta.env.PROD
          ? 'wss://ai-prof-voice-gateway.onrender.com/ws/voice'
          : 'ws://localhost:3002/ws/voice');

      // Automatically convert http/https protocol to ws/wss if provided
      if (baseWs.startsWith('https://')) {
        baseWs = 'wss://' + baseWs.slice(8);
      } else if (baseWs.startsWith('http://')) {
        baseWs = 'ws://' + baseWs.slice(7);
      }

      // Remove trailing slashes
      baseWs = baseWs.replace(/\/+$/, '');

      // Ensure /ws/voice endpoint is present without duplicating it
      const wsEndpoint = baseWs.endsWith('/ws/voice') ? baseWs : `${baseWs}/ws/voice`;
      const wsUrl = qs ? `${wsEndpoint}?${qs}` : wsEndpoint;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setSessionHealth('healthy');
        lastPongTimeRef.current = Date.now();
        console.log('Connected to Voice Gateway');
        sendLifecycleEvent('WS_CLIENT_CONNECTED');
        if (savedId) {
          ws.send(JSON.stringify({ type: 'RESUME_SESSION', conversationId: savedId }));
        }

        // Start periodic heartbeat keepalive (every 8s)
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const now = Date.now();
            if (now - lastPongTimeRef.current > 16000) {
              console.warn('⚠️ WebSocket heartbeat missed; marking degraded and reconnecting');
              setSessionHealth('degraded');
              ws.close();
              return;
            }
            ws.send(JSON.stringify({ type: 'HEARTBEAT_PING', clientTimestamp: now }));
          }
        }, 8000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'HEARTBEAT_PONG') {
            lastPongTimeRef.current = Date.now();
            setSessionHealth('healthy');
            if (data.clientTimestamp) {
              const rtt = Math.max(1, Date.now() - data.clientTimestamp);
              setRttLatency(rtt);
            }
            return;
          }

          if (data.type === 'ERROR') {
            sendLifecycleEvent('ERROR_FROM_GATEWAY', { error: data.error });
            setFillerText(null);
            setVoiceState('idle');
            setMessages((prev) => [
              ...prev,
              {
                sender: 'system',
                text: `Voice system notice: ${data.error}. Please try speaking again.`,
              },
            ]);
            return;
          }

          if (data.type === 'AGENT_FILLER') {
            setFillerText(data.fillerText);
            return;
          }

          if (data.type === 'AGENT_TURN') {
            setFillerText(null);
            setActiveCapability(data.capabilityCalled || null);
            if (data.latencyMs) {
              setLastTurnLatency(data.latencyMs);
            }
            if (data.conversationId) {
              setConversationId(data.conversationId);
              const user = ApiService.getCurrentUser();
              const key = user?.patientId ? `active_voice_conversation_id_${user.patientId}` : 'active_voice_conversation_id';
              localStorage.setItem(key, data.conversationId);
            }

            setMessages((prev) => [
              ...prev,
              {
                sender: 'agent',
                text: data.spokenText,
                capability: data.capabilityCalled,
                transferred: data.transferredToHuman,
              },
            ]);

            if (data.intentDetected === 'BOOKING_CONFIRMED' || data.transferredToHuman) {
              isContinuousSessionRef.current = false;
              setIsContinuousActive(false);
            }

            if (data.intentDetected === 'BOOKING_CONFIRMED' && onAppointmentBookedRef.current) {
              onAppointmentBookedRef.current();
            }

            // Speak response
            speakText(data.spokenText);
          } else if (data.type === 'SESSION_RESTORED') {
            console.log('Voice session successfully restored:', data.conversationId);
          }
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      ws.onclose = () => {
        isConnectingRef.current = false;
        setIsConnected(false);
        setSessionHealth('disconnected');
        setVoiceState('idle');
        if (heartbeatTimerRef.current) {
          clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
        if (!reconnectTimerRef.current) {
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connectWebSocket();
          }, 3000);
        }
      };

      ws.onerror = () => {
        isConnectingRef.current = false;
        setIsConnected(false);
        setSessionHealth('degraded');
      };
    } catch {
      isConnectingRef.current = false;
      setIsConnected(false);
      setSessionHealth('disconnected');
    }
  }, [speakText, sendLifecycleEvent]);

  useEffect(() => {
    connectWebSocket();
    if (!recognitionRef.current) {
      recognitionRef.current = setupSpeechRecognition();
    }
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // Run once on mount to prevent reconnect storm

  // Start Audio Capture and Recognition
  const startListening = useCallback(async () => {
    try {
      isStoppingRef.current = false;
      accumulatedTranscriptRef.current = '';
      await startAudioCapture();

      if (!recognitionRef.current) {
        recognitionRef.current = setupSpeechRecognition();
      }

      if (recognitionRef.current) {
        if (isRecognizingRef.current || isStartingRef.current) {
          setVoiceState('listening');
          return;
        }

        try {
          isStartingRef.current = true;
          recognitionRef.current.start();
          setVoiceState('listening');
        } catch (e: any) {
          isStartingRef.current = false;
          if (e.name === 'InvalidStateError') {
            isRecognizingRef.current = true;
            setVoiceState('listening');
          } else {
            console.warn('SpeechRecognition start notice:', e);
            setVoiceState('listening');
          }
        }
      } else {
        setVoiceState('listening');
      }
    } catch (err: any) {
      isStartingRef.current = false;
      console.error('Failed to start voice capture:', err);
      setMicError('Could not start microphone. Please check browser permissions.');
      setVoiceState('idle');
      isContinuousSessionRef.current = false;
      setIsContinuousActive(false);
      stopAudioCapture();
    }
  }, [setupSpeechRecognition]);

  // Keep startListeningRef synchronized
  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  // Stop / Pause Hands-Free Voice Session
  const stopListening = useCallback(() => {
    isStoppingRef.current = true;
    isContinuousSessionRef.current = false;
    setIsContinuousActive(false);
    if (recognitionRef.current && isRecognizingRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
      isRecognizingRef.current = false;
    }
    stopAudioCapture();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setVoiceState('idle');
  }, []);

  // Main Orb Click Handler
  const handleMicToggle = async () => {
    setMicError(null);

    // If agent is thinking or speaking, clicking immediately interrupts and transitions directly to listening
    if (voiceState === 'thinking' || voiceState === 'speaking') {
      isStoppingRef.current = true;
      cancelSpeechAndBargeIn();
      if (recognitionRef.current && isRecognizingRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
        isRecognizingRef.current = false;
      }
      stopAudioCapture();
      isContinuousSessionRef.current = true;
      setIsContinuousActive(true);
      setTimeout(() => {
        isStoppingRef.current = false;
        startListening();
      }, 60);
      return;
    } else if (voiceState === 'listening') {
      // If already listening, clicking submits spoken words or pauses/cancels cleanly
      if (accumulatedTranscriptRef.current.trim()) {
        handlePatientUtterance(accumulatedTranscriptRef.current);
      } else {
        stopListening();
      }
      return;
    }

    // Start hands-free continuous voice session from idle
    isContinuousSessionRef.current = true;
    setIsContinuousActive(true);
    setVoiceState('listening');

    await startListening();
  };

  return (
    <div className="glass-panel rounded-2xl p-5 shadow-2xl border border-teal-500/20 flex flex-col relative">
      {/* 1. Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-teal-500/10 text-teal-400 rounded-lg border border-teal-500/30">
            <Sparkles className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="font-semibold text-base text-white">Conversational Voice Agent</h2>
              {(isContinuousActive || voiceState === 'listening') && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/20 text-sky-400 border border-sky-500/40 animate-pulse">
                  <Radio className="w-3 h-3 mr-1 text-sky-400 animate-spin" /> LIVE MIC
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400">Autonomous Intake, Discovery & Real-Time Scheduling</p>
          </div>
        </div>

        <div className="flex flex-col items-end space-y-1">
          <div className="flex items-center space-x-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                sessionHealth === 'healthy'
                  ? 'bg-emerald-400 animate-pulse'
                  : sessionHealth === 'degraded'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-rose-500'
              }`}
            />
            <span
              className={`text-xs font-mono font-semibold ${
                sessionHealth === 'healthy'
                  ? 'text-emerald-400'
                  : sessionHealth === 'degraded'
                  ? 'text-amber-400'
                  : 'text-rose-400'
              }`}
            >
              {sessionHealth === 'healthy'
                ? `GATEWAY LIVE ${rttLatency ? `(${rttLatency}ms)` : ''}`
                : sessionHealth === 'degraded'
                ? 'CONNECTION DEGRADED'
                : 'RECONNECTING...'}
            </span>
          </div>

          <div className="flex items-center space-x-2 text-[10px] text-slate-400 font-mono">
            <span className="bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700/60">
              VAD 1.4s
            </span>
            <span className="bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700/60">
              PCM 16kHz
            </span>
            {conversationId && (
              <span
                title={`Session ID: ${conversationId}`}
                className="bg-teal-950/60 text-teal-300 px-1.5 py-0.5 rounded border border-teal-500/30 truncate max-w-[100px]"
              >
                ID: {conversationId.slice(0, 8)}...
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Stationary Center Voice Orb Visualizer Section (Fixed height: never moves upward or downward) */}
      <div className="flex flex-col items-center justify-center py-4 shrink-0">
        {/* Dynamic Sound-Reactive Voice Orb (Locked fixed coordinates) */}
        <div className="relative flex items-center justify-center w-[150px] h-[150px]">
          {voiceState === 'listening' && (
            <div
              className="absolute rounded-full bg-sky-400/20 animate-ping pointer-events-none"
              style={{
                width: `${135 + Math.min(micVolume * 0.4, 25)}px`,
                height: `${135 + Math.min(micVolume * 0.4, 25)}px`,
              }}
            />
          )}

          {voiceState === 'speaking' && (
            <div className="absolute w-36 h-36 rounded-full bg-purple-500/20 animate-pulse pointer-events-none" />
          )}

          <div
            onClick={handleMicToggle}
            id="voice-orb-button"
            role="button"
            tabIndex={0}
            title={
              voiceState === 'listening'
                ? 'Listening to you now — speak naturally or click to pause'
                : voiceState === 'speaking'
                ? 'Agent speaking — click to interrupt (barge-in)'
                : 'Click to start voice conversation (Continuous Multi-Turn Enabled)'
            }
            className={`voice-orb cursor-pointer flex items-center justify-center z-10 select-none transition-transform duration-200 ${
              voiceState === 'listening'
                ? 'listening ring-4 ring-sky-400/60 shadow-[0_0_50px_rgba(56,189,248,0.5)]'
                : voiceState === 'speaking'
                ? 'speaking ring-4 ring-purple-400/60 shadow-[0_0_50px_rgba(168,85,247,0.5)]'
                : voiceState === 'thinking'
                ? 'thinking ring-4 ring-amber-400/60 shadow-[0_0_40px_rgba(251,191,36,0.4)]'
                : 'hover:scale-105 hover:ring-2 hover:ring-teal-400/40'
            }`}
          >
            {voiceState === 'listening' ? (
              <div className="flex flex-col items-center justify-center text-white">
                <Mic className="w-10 h-10 text-sky-200 animate-bounce" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-sky-200 mt-1">
                  {micVolume > 15 ? 'Hearing you' : 'Listening...'}
                </span>
              </div>
            ) : voiceState === 'speaking' ? (
              <div className="flex flex-col items-center justify-center text-white">
                <Volume2 className="w-10 h-10 text-purple-200 animate-pulse" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-purple-200 mt-1">
                  Interrupt
                </span>
              </div>
            ) : voiceState === 'thinking' ? (
              <div className="flex flex-col items-center justify-center text-white">
                <Sparkles className="w-10 h-10 text-amber-200 animate-spin" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-200 mt-1">
                  Thinking
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-teal-100">
                <Mic className="w-10 h-10" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-teal-200/80 mt-1">
                  Click to Talk
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Real-Time Audio Frequency Spectrum Waveform (7 Bands) - Fixed Height */}
        <div className="flex items-center justify-center space-x-1.5 h-8 mt-2.5 px-3 py-1 bg-slate-900/70 rounded-full border border-slate-800">
          {audioLevels.map((lvl, index) => (
            <div
              key={index}
              className={`w-1.5 audio-wave-bar ${
                voiceState === 'listening'
                  ? 'bg-sky-400'
                  : voiceState === 'speaking'
                  ? 'bg-purple-400'
                  : voiceState === 'thinking'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-slate-700'
              }`}
              style={{ height: `${Math.max(4, Math.min(lvl, 22))}px` }}
            />
          ))}
          <span className="text-[10px] font-mono ml-2 text-slate-400">
            {voiceState === 'listening' ? (
              <span className="text-sky-400 font-medium">Listening... {micVolume > 0 ? `(${micVolume}%)` : ''}</span>
            ) : voiceState === 'speaking' ? (
              <span className="text-purple-400 font-medium">Agent Speaking</span>
            ) : voiceState === 'thinking' ? (
              <span className="text-amber-400 font-medium">Coordinating AI...</span>
            ) : (
              <span className="text-slate-500">Hands-Free Multi-Turn Ready</span>
            )}
          </span>
        </div>

        {/* Status Badge & Control Actions - Fixed Height */}
        <div className="mt-2.5 flex items-center justify-center space-x-2 h-8">
          <div
            className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold tracking-wide border ${
              voiceState === 'listening'
                ? 'bg-sky-950/80 text-sky-300 border-sky-500/40 shadow-lg shadow-sky-500/10'
                : voiceState === 'thinking'
                ? 'bg-amber-950/80 text-amber-300 border-amber-500/40 shadow-lg shadow-amber-500/10'
                : voiceState === 'speaking'
                ? 'bg-purple-950/80 text-purple-300 border-purple-500/40 shadow-lg shadow-purple-500/10'
                : 'bg-slate-800/80 text-teal-300 border-teal-500/20'
            }`}
          >
            {voiceState === 'listening' ? (
              <>
                <Radio className="w-3 h-3 mr-1 text-sky-400 animate-pulse" />
                <span>Listening... (Speak naturally, auto-submits on pause)</span>
              </>
            ) : voiceState === 'thinking' ? (
              <>
                <Sparkles className="w-3 h-3 mr-1 text-amber-400 animate-spin" />
                <span>AI coordinating hospital availability & capabilities...</span>
              </>
            ) : voiceState === 'speaking' ? (
              <>
                <Volume2 className="w-3 h-3 mr-1 text-purple-400 animate-pulse" />
                <span>Agent speaking — click orb or button to interrupt</span>
              </>
            ) : (
              <span>Click Orb to start conversation (continuous multi-turn)</span>
            )}
          </div>

          {/* Barge-in Quick Action when Agent is Speaking */}
          {voiceState === 'speaking' && (
            <button
              type="button"
              onClick={cancelSpeechAndBargeIn}
              className="inline-flex items-center px-2.5 py-1 bg-rose-950/80 hover:bg-rose-900 text-rose-200 border border-rose-500/40 rounded-full text-[11px] font-semibold transition"
            >
              <Square className="w-2.5 h-2.5 mr-1 text-rose-400 fill-rose-400" />
              <span>Interrupt</span>
            </button>
          )}

          {/* Pause Voice Session Button */}
          {(isContinuousActive || voiceState === 'listening') && voiceState !== 'speaking' && (
            <button
              type="button"
              onClick={stopListening}
              className="inline-flex items-center px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-full text-[11px] font-medium transition"
              title="Pause hands-free voice mode"
            >
              <MicOff className="w-2.5 h-2.5 mr-1 text-slate-400" />
              <span>Pause Mic</span>
            </button>
          )}
        </div>

        {/* Transient Info Row (Fixed Height to prevent vertical shifts) */}
        <div className="mt-1.5 h-6 flex items-center justify-center text-[11px]">
          {micError ? (
            <div className="flex items-center space-x-1.5 text-amber-300 bg-amber-950/70 px-2.5 py-0.5 rounded-md border border-amber-500/40">
              <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0" />
              <span>{micError}</span>
              <button
                onClick={() => setMicError(null)}
                className="text-amber-400 hover:text-white font-bold ml-1"
              >
                ×
              </button>
            </div>
          ) : fillerText ? (
            <div className="flex items-center space-x-1.5 text-amber-300 bg-amber-950/70 px-2.5 py-0.5 rounded-md border border-amber-500/40 animate-pulse">
              <Sparkles className="w-3 h-3 text-amber-400" />
              <span>{fillerText}</span>
            </div>
          ) : activeCapability ? (
            <div className="flex items-center space-x-1.5 text-teal-400 bg-teal-950/60 px-2.5 py-0.5 rounded-md border border-teal-500/30">
              <CheckCircle2 className="w-3 h-3" />
              <span>Capability Executed: <strong>{activeCapability}</strong></span>
            </div>
          ) : lastTurnLatency !== null ? (
            <span className="font-mono text-slate-500">
              Turn Latency: <strong className="text-teal-400 font-semibold">{lastTurnLatency}ms</strong> (&lt;2000ms target ✅)
            </span>
          ) : null}
        </div>
      </div>

      {/* 3. Live Conversation Transcript (Internally scrollable, no window jumping) */}
      <div
        ref={chatContainerRef}
        className="h-[250px] min-h-[250px] max-h-[250px] overflow-y-auto space-y-2.5 px-3 py-3 bg-slate-950/70 rounded-xl border border-slate-800/80 mb-3 flex-shrink-0"
      >
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[85%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed ${
                msg.sender === 'user'
                  ? 'bg-gradient-to-r from-teal-600 to-teal-700 text-white rounded-tr-none shadow-md'
                  : msg.transferred
                  ? 'bg-rose-950/80 border border-rose-500/50 text-rose-100 rounded-tl-none'
                  : 'bg-slate-800/90 text-slate-100 border border-slate-700/60 rounded-tl-none'
              }`}
            >
              {msg.transferred && (
                <div className="flex items-center space-x-1 text-[11px] text-rose-400 font-semibold mb-1">
                  <ShieldAlert className="w-3 h-3" />
                  <span>Clinical Safety Guardrail Activated (Transferred to Human)</span>
                </div>
              )}
              <p>{msg.text}</p>
            </div>
            {msg.capability && (
              <span className="text-[9px] text-teal-400/70 font-mono mt-0.5 px-1">
                Capability: {msg.capability}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* 4. Suggested Quick Natural Prompts */}
      <div className="mb-3 shrink-0">
        <p className="text-[11px] text-slate-400 font-medium mb-1.5 flex items-center">
          <ChevronRight className="w-3 h-3 text-teal-400 mr-1" /> Quick suggestions (speak or tap):
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => handlePatientUtterance('I need to see a doctor for my shoulder pain sometime this week.')}
            className="text-[11px] bg-slate-800/80 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded-lg border border-slate-700 transition"
          >
            "Shoulder pain doctor this week"
          </button>
          <button
            onClick={() => handlePatientUtterance('I am looking for a cardiologist')}
            className="text-[11px] bg-slate-800/80 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded-lg border border-slate-700 transition"
          >
            "Find a cardiologist"
          </button>
          <button
            onClick={() => handlePatientUtterance('Yes, please check their appointments.')}
            className="text-[11px] bg-slate-800/80 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded-lg border border-slate-700 transition"
          >
            "Yes, check appointments"
          </button>
          <button
            onClick={() => handlePatientUtterance('What medication should I take for this pain?')}
            className="text-[11px] bg-rose-950/50 hover:bg-rose-900/60 text-rose-300 px-2.5 py-1 rounded-lg border border-rose-700/50 transition flex items-center space-x-1"
          >
            <ShieldAlert className="w-3 h-3" />
            <span>Test Clinical Guardrail</span>
          </button>
        </div>
      </div>

      {/* 5. Text Input Fallback */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handlePatientUtterance(inputText);
        }}
        className="flex items-center space-x-2 shrink-0"
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Describe your healthcare need naturally..."
          className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 transition"
        />
        <button
          type="submit"
          className="bg-teal-600 hover:bg-teal-500 text-white px-3.5 py-2 rounded-xl text-xs font-medium transition shadow-lg shadow-teal-500/20 flex items-center space-x-1"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};
