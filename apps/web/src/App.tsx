import React, { useState } from 'react';
import { UserRole } from './types.js';
import { PatientPortal } from './components/PatientPortal.js';
import { DoctorPortal } from './components/DoctorPortal.js';
import { HospitalAdminPortal } from './components/HospitalAdminPortal.js';
import { PlatformAdminPortal } from './components/PlatformAdminPortal.js';
import { ChaosModal } from './components/ChaosModal.js';
import { HeartPulse, User, Stethoscope, Building2, Shield, Zap, Sparkles } from 'lucide-react';

export const App: React.FC = () => {
  const [currentRole, setCurrentRole] = useState<UserRole>('PATIENT');
  const [isChaosOpen, setIsChaosOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Brand Logo */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-teal-500 to-cyan-500 flex items-center justify-center text-white shadow-lg shadow-teal-500/20">
              <HeartPulse className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="font-bold text-base tracking-tight text-white">AI.Prof Healthcare</h1>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-teal-500/20 text-teal-300 border border-teal-500/30">
                  Candidate v2.0
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Autonomous Intake, Scheduling & AI Operations</p>
            </div>
          </div>

          {/* Role Switcher Tabs */}
          <nav className="hidden md:flex items-center space-x-1 bg-slate-900/90 p-1.5 rounded-xl border border-slate-800">
            <button
              onClick={() => setCurrentRole('PATIENT')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                currentRole === 'PATIENT'
                  ? 'bg-teal-600 text-white shadow-md shadow-teal-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <User className="w-3.5 h-3.5" />
              <span>Patient Intake</span>
            </button>

            <button
              onClick={() => setCurrentRole('DOCTOR')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                currentRole === 'DOCTOR'
                  ? 'bg-teal-600 text-white shadow-md shadow-teal-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Stethoscope className="w-3.5 h-3.5" />
              <span>Doctor Portal</span>
            </button>

            <button
              onClick={() => setCurrentRole('HOSPITAL_ADMIN')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                currentRole === 'HOSPITAL_ADMIN'
                  ? 'bg-teal-600 text-white shadow-md shadow-teal-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>Hospital Admin</span>
            </button>

            <button
              onClick={() => setCurrentRole('PLATFORM_ADMIN')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                currentRole === 'PLATFORM_ADMIN'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Platform Admin</span>
            </button>
          </nav>

          {/* Quick Action: Chaos & Failure Simulator */}
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setIsChaosOpen(true)}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-xl text-xs font-medium transition"
            >
              <Zap className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Fault Simulator</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {currentRole === 'PATIENT' && <PatientPortal />}
        {currentRole === 'DOCTOR' && <DoctorPortal />}
        {currentRole === 'HOSPITAL_ADMIN' && <HospitalAdminPortal />}
        {currentRole === 'PLATFORM_ADMIN' && <PlatformAdminPortal />}
      </main>

      {/* Global Chaos Modal */}
      <ChaosModal isOpen={isChaosOpen} onClose={() => setIsChaosOpen(false)} />
    </div>
  );
};
