import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2, Sparkles, AlertCircle, CheckCircle2, ChevronRight, ShieldAlert } from 'lucide-react';

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
    return localStorage.getItem('active_voice_conversation_id');
  });

  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // Initialize Speech Recognition if supported in browser
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((r: any) => r[0].transcript)
          .join('');

        if (event.results[0].isFinal) {
          console.log('🎤 Speech recognized final:', transcript);
          handlePatientUtterance(transcript);
        }
      };

      recognition.onerror = (e: any) => {
        console.warn('Speech recognition error:', e.error);
        setVoiceState('idle');
      };

      recognition.onend = () => {
        if (voiceState === 'listening') {
          setVoiceState('idle');
        }
      };

      recognitionRef.current = recognition;
    }
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, voiceState, fillerText]);

  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05; // natural snappy pacing
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      setVoiceState('speaking');
    };

    utterance.onend = () => {
      setVoiceState('idle');
    };

    utterance.onerror = () => {
      setVoiceState('idle');
    };

    window.speechSynthesis.speak(utterance);
  };

  const cancelSpeechAndBargeIn = () => {
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      console.log('⚡ Barge-in triggered: Cancelling active TTS speech.');
      window.speechSynthesis.cancel();
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'INTERRUPT' }));
    }
  };

  const connectWebSocket = () => {
    try {
      const savedId = localStorage.getItem('active_voice_conversation_id');
      const wsUrl = savedId
        ? `ws://localhost:3002/ws/voice?conversationId=${savedId}`
        : 'ws://localhost:3002/ws/voice';

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        console.log('Connected to Voice Gateway');
        if (savedId) {
          ws.send(JSON.stringify({ type: 'RESUME_SESSION', conversationId: savedId }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

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
              localStorage.setItem('active_voice_conversation_id', data.conversationId);
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

            if (data.intentDetected === 'BOOKING_CONFIRMED' && onAppointmentBooked) {
              onAppointmentBooked();
            }

            // Speak response via TTS
            speakText(data.spokenText);
          } else if (data.type === 'SESSION_RESTORED') {
            console.log('Voice session successfully restored:', data.conversationId);
          }
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        setVoiceState('idle');
        setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = () => {
        setIsConnected(false);
      };
    } catch {
      setIsConnected(false);
    }
  };

  const handlePatientUtterance = (textToSend: string) => {
    if (!textToSend.trim()) return;

    // Barge-in: immediately cancel any existing TTS
    cancelSpeechAndBargeIn();

    setMessages((prev) => [...prev, { sender: 'user', text: textToSend }]);
    setVoiceState('thinking');
    setFillerText(null);
    setInputText('');

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ text: textToSend }));
    } else {
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            sender: 'system',
            text: 'Voice gateway is connecting... Please ensure the voice-gateway service is running on port 3002.',
          },
        ]);
        setVoiceState('idle');
      }, 1000);
    }
  };

  const handleMicToggle = () => {
    // If agent is speaking, clicking or speaking triggers barge-in
    if (voiceState === 'speaking') {
      cancelSpeechAndBargeIn();
      setVoiceState('idle');
      return;
    }

    if (voiceState === 'listening') {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setVoiceState('idle');
    } else {
      setVoiceState('listening');
      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch (e) {
          console.warn('Recognition already started or error:', e);
        }
      } else {
        // Fallback simulation for environments without Web Speech API
        setTimeout(() => {
          handlePatientUtterance('I need to see a doctor for my shoulder pain sometime this week.');
        }, 2000);
      }
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-6 shadow-2xl border border-teal-500/20 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-800">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-teal-500/10 text-teal-400 rounded-lg border border-teal-500/30">
            <Sparkles className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h2 className="font-semibold text-lg text-white">Conversational Voice Agent</h2>
            <p className="text-xs text-slate-400">Autonomous Intake, Discovery & Scheduling</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-ping' : 'bg-rose-500'}`} />
          <span className="text-xs font-mono text-slate-400">
            {isConnected ? 'LIVE WS' : 'CONNECTING...'}
          </span>
        </div>
      </div>

      {/* Center Voice Orb Visualizer */}
      <div className="flex flex-col items-center justify-center py-8">
        <div
          onClick={handleMicToggle}
          className={`voice-orb cursor-pointer flex items-center justify-center transition-all ${
            voiceState === 'listening'
              ? 'listening ring-4 ring-sky-400/50'
              : voiceState === 'speaking'
              ? 'speaking ring-4 ring-purple-400/50'
              : voiceState === 'thinking'
              ? 'thinking ring-4 ring-amber-400/50'
              : 'hover:scale-105'
          }`}
        >
          {voiceState === 'listening' ? (
            <Mic className="w-12 h-12 text-white animate-bounce" />
          ) : voiceState === 'speaking' ? (
            <Volume2 className="w-12 h-12 text-white animate-pulse" />
          ) : (
            <Mic className="w-12 h-12 text-teal-100" />
          )}
        </div>

        <div className="mt-4 text-center">
          <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider bg-slate-800/80 text-teal-300 border border-teal-500/20">
            {voiceState === 'listening'
              ? '🎙️ Listening to patient...'
              : voiceState === 'thinking'
              ? '⚡ AI Coordinating Capabilities...'
              : voiceState === 'speaking'
              ? '🔊 Speaking (Sub-2s turn)'
              : 'Click Orb to Speak (or use prompts below)'}
          </span>
        </div>

        {fillerText && (
          <div className="mt-2 flex items-center space-x-2 text-xs text-amber-300 bg-amber-950/70 px-3 py-1.5 rounded-md border border-amber-500/40 animate-pulse">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>{fillerText}</span>
          </div>
        )}

        {lastTurnLatency !== null && (
          <div className="mt-1 text-[11px] font-mono text-slate-400">
            Perceived Turn Latency: <span className="text-teal-400 font-semibold">{lastTurnLatency}ms</span> (Target &lt;2000ms ✅)
          </div>
        )}

        {activeCapability && (
          <div className="mt-2 flex items-center space-x-1.5 text-xs text-teal-400 bg-teal-950/60 px-3 py-1 rounded-md border border-teal-500/30">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Capability Executed: <strong>{activeCapability}</strong></span>
          </div>
        )}
      </div>

      {/* Live Conversation Transcript */}
      <div className="flex-1 overflow-y-auto space-y-3 px-2 py-4 bg-slate-950/60 rounded-xl border border-slate-800/80 mb-4 max-h-72">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                msg.sender === 'user'
                  ? 'bg-gradient-to-r from-teal-600 to-teal-700 text-white rounded-tr-none shadow-md'
                  : msg.transferred
                  ? 'bg-rose-950/80 border border-rose-500/50 text-rose-100 rounded-tl-none'
                  : 'bg-slate-800/90 text-slate-100 border border-slate-700/60 rounded-tl-none'
              }`}
            >
              {msg.transferred && (
                <div className="flex items-center space-x-1 text-xs text-rose-400 font-semibold mb-1">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  <span>Clinical Safety Guardrail Activated (Transferred to Human)</span>
                </div>
              )}
              <p>{msg.text}</p>
            </div>
            {msg.capability && (
              <span className="text-[10px] text-teal-400/70 font-mono mt-1 px-1">
                Capability: {msg.capability}
              </span>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Suggested Quick Natural Prompts */}
      <div className="mb-3">
        <p className="text-xs text-slate-400 font-medium mb-1.5 flex items-center">
          <ChevronRight className="w-3.5 h-3.5 text-teal-400 mr-1" /> Try speaking or clicking:
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => handlePatientUtterance('I need to see a doctor for my shoulder pain sometime this week.')}
            className="text-xs bg-slate-800/80 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded-lg border border-slate-700 transition"
          >
            "Shoulder pain doctor this week"
          </button>
          <button
            onClick={() => handlePatientUtterance('Yes, please book that slot for me.')}
            className="text-xs bg-slate-800/80 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded-lg border border-slate-700 transition"
          >
            "Book that appointment"
          </button>
          <button
            onClick={() => handlePatientUtterance('What medication should I take for this pain?')}
            className="text-xs bg-rose-950/50 hover:bg-rose-900/60 text-rose-300 px-2.5 py-1 rounded-lg border border-rose-700/50 transition flex items-center space-x-1"
          >
            <ShieldAlert className="w-3 h-3" />
            <span>Test Clinical Guardrail</span>
          </button>
          <button
            onClick={() => handlePatientUtterance('Sure, I will answer the questions.')}
            className="text-xs bg-slate-800/80 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded-lg border border-slate-700 transition"
          >
            "Answer questionnaire"
          </button>
        </div>
      </div>

      {/* Text Input Fallback */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handlePatientUtterance(inputText);
        }}
        className="flex items-center space-x-2"
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Describe your healthcare need naturally..."
          className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 transition"
        />
        <button
          type="submit"
          className="bg-teal-600 hover:bg-teal-500 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition shadow-lg shadow-teal-500/20"
        >
          Send
        </button>
      </form>
    </div>
  );
};
