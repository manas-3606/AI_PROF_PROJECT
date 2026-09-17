import React, { useState, useEffect } from 'react';
import { ApiService } from '../services/api.js';
import { AlertTriangle, Zap, RotateCcw, X, CheckCircle2, ShieldAlert } from 'lucide-react';

interface ChaosModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ChaosModal: React.FC<ChaosModalProps> = ({ isOpen, onClose }) => {
  const [latency, setLatency] = useState<number>(0);
  const [failureMode, setFailureMode] = useState<string>('NONE');
  const [statusText, setStatusText] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      loadChaosStatus();
    }
  }, [isOpen]);

  const loadChaosStatus = async () => {
    try {
      const data = await ApiService.getChaosStatus();
      if (data.chaosConfig) {
        setLatency(data.chaosConfig.simulatedLatencyMs || 0);
        setFailureMode(data.chaosConfig.failureMode || 'NONE');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleApply = async (mode: string, latencyMs: number) => {
    try {
      await ApiService.configureChaos({
        failureMode: mode,
        simulatedLatencyMs: latencyMs,
      });
      setFailureMode(mode);
      setLatency(latencyMs);
      setStatusText(`Applied fault injection: ${mode} with ${latencyMs}ms delay`);
      setTimeout(() => setStatusText(''), 4000);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleReset = async () => {
    try {
      await ApiService.resetChaos();
      setFailureMode('NONE');
      setLatency(0);
      setStatusText('Reset chaos settings to normal happy path.');
      setTimeout(() => setStatusText(''), 4000);
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-amber-500/20 text-amber-400 rounded-xl border border-amber-500/40">
              <AlertTriangle className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">EHR Chaos & Failure Injection Panel</h3>
              <p className="text-xs text-slate-400">
                Simulate PRD Section 28 Failure Scenarios (Option B Timeout Recovery & Option C Escalation)
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {statusText && (
          <div className="p-3 bg-emerald-950/80 border border-emerald-500/40 rounded-xl text-xs text-emerald-300 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>{statusText}</span>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
              Select Failure Mode (Simulated at External EHR Gateway)
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div
                onClick={() => handleApply('NONE', 0)}
                className={`p-3.5 rounded-xl border cursor-pointer transition ${
                  failureMode === 'NONE'
                    ? 'bg-teal-950/40 border-teal-500 ring-2 ring-teal-500/30'
                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center space-x-2 mb-1">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-sm font-semibold text-white">Normal (Happy Path)</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Instant response, fast verification, immediate appointment confirmation.
                </p>
              </div>

              <div
                onClick={() => handleApply('TIMEOUT', 5500)}
                className={`p-3.5 rounded-xl border cursor-pointer transition ${
                  failureMode === 'TIMEOUT'
                    ? 'bg-amber-950/40 border-amber-500 ring-2 ring-amber-500/30'
                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center space-x-2 mb-1">
                  <Zap className="w-4 h-4 text-amber-400" />
                  <span className="text-sm font-semibold text-white">Option B: EHR Timeout</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Times out on POST, triggers recovery state machine to query EHR rather than duplicate.
                </p>
              </div>

              <div
                onClick={() => handleApply('PHANTOM_CREATION', 5500)}
                className={`p-3.5 rounded-xl border cursor-pointer transition ${
                  failureMode === 'PHANTOM_CREATION'
                    ? 'bg-sky-950/40 border-sky-500 ring-2 ring-sky-500/30'
                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center space-x-2 mb-1">
                  <Zap className="w-4 h-4 text-sky-400" />
                  <span className="text-sm font-semibold text-white">Phantom Creation</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  EHR saves record but network socket drops. Verifier detects record exists and avoids duplicate!
                </p>
              </div>

              <div
                onClick={() => handleApply('500_ERROR', 0)}
                className={`p-3.5 rounded-xl border cursor-pointer transition ${
                  failureMode === '500_ERROR'
                    ? 'bg-rose-950/40 border-rose-500 ring-2 ring-rose-500/30'
                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center space-x-2 mb-1">
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                  <span className="text-sm font-semibold text-white">Option C: Fatal 500 Error</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Downstream outage. Retries exhaust, moves to Reconciliation Required & escalates to human.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-between items-center pt-4 border-t border-slate-800">
          <button
            onClick={handleReset}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-600 transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset All Chaos</span>
          </button>

          <button
            onClick={onClose}
            className="px-5 py-2 text-xs rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-medium transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
