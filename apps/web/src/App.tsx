import React, { useState, useEffect } from 'react';
import { User, UserRole } from './types.js';
import { ApiService } from './services/api.js';
import { LoginPage } from './components/LoginPage.js';
import { PatientPortal } from './components/PatientPortal.js';
import { DoctorPortal } from './components/DoctorPortal.js';
import { HospitalAdminPortal } from './components/HospitalAdminPortal.js';
import { PlatformAdminPortal } from './components/PlatformAdminPortal.js';
import { ChaosModal } from './components/ChaosModal.js';
import {
  HeartPulse,
  User as UserIcon,
  Stethoscope,
  Building2,
  Shield,
  Zap,
  LogOut,
} from 'lucide-react';

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeAdminView, setActiveAdminView] = useState<UserRole>('PLATFORM_ADMIN');
  const [isChaosOpen, setIsChaosOpen] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);

  // Check persisted session on initial mount
  useEffect(() => {
    const token = ApiService.getToken();
    const savedUser = ApiService.getCurrentUser();
    if (token && savedUser) {
      setCurrentUser(savedUser);
      if (savedUser.role === 'PLATFORM_ADMIN') {
        setActiveAdminView('PLATFORM_ADMIN');
      }
    }
    setIsInitializing(false);
  }, []);

  const handleLoginSuccess = (user: User) => {
    setCurrentUser(user);
    if (user.role === 'PLATFORM_ADMIN') {
      setActiveAdminView('PLATFORM_ADMIN');
    }
  };

  const handleLogout = () => {
    ApiService.logout();
    setCurrentUser(null);
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-sm">
        Loading session...
      </div>
    );
  }

  // Not logged in -> Show Login Page
  if (!currentUser) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  // Role metadata
  const roleLabels: Record<UserRole, { title: string; badge: string; icon: React.ReactNode }> = {
    PATIENT: {
      title: 'Patient Access Portal',
      badge: 'bg-teal-500/10 text-teal-400 border-teal-500/30',
      icon: <UserIcon className="w-3.5 h-3.5" />,
    },
    DOCTOR: {
      title: 'Clinical Provider Portal',
      badge: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
      icon: <Stethoscope className="w-3.5 h-3.5" />,
    },
    HOSPITAL_ADMIN: {
      title: 'Hospital Operations Portal',
      badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
      icon: <Building2 className="w-3.5 h-3.5" />,
    },
    PLATFORM_ADMIN: {
      title: 'Platform Governance Portal',
      badge: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
      icon: <Shield className="w-3.5 h-3.5" />,
    },
  };

  const currentRoleMeta = roleLabels[currentUser.role];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Brand Logo & Portal Context */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-teal-500 to-cyan-500 flex items-center justify-center text-white shadow-lg shadow-teal-500/20">
              <HeartPulse className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="font-bold text-base tracking-tight text-white">AI.Prof Healthcare</h1>
                <span
                  className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border flex items-center space-x-1 ${currentRoleMeta.badge}`}
                >
                  {currentRoleMeta.icon}
                  <span className="ml-1">{currentUser.role.replace('_', ' ')}</span>
                </span>
              </div>
              <p className="text-[11px] text-slate-400">{currentRoleMeta.title}</p>
            </div>
          </div>

          {/* Platform Admin View Switcher (Platform Admin only - for system auditing) */}
          {currentUser.role === 'PLATFORM_ADMIN' && (
            <nav className="hidden lg:flex items-center space-x-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 px-2 font-semibold">
                Audit Scope:
              </span>
              <button
                onClick={() => setActiveAdminView('PLATFORM_ADMIN')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                  activeAdminView === 'PLATFORM_ADMIN'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Platform Governance
              </button>
              <button
                onClick={() => setActiveAdminView('HOSPITAL_ADMIN')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                  activeAdminView === 'HOSPITAL_ADMIN'
                    ? 'bg-amber-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Hospital Admin View
              </button>
              <button
                onClick={() => setActiveAdminView('DOCTOR')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                  activeAdminView === 'DOCTOR'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Doctor View
              </button>
              <button
                onClick={() => setActiveAdminView('PATIENT')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                  activeAdminView === 'PATIENT'
                    ? 'bg-teal-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Patient View
              </button>
            </nav>
          )}

          {/* User Profile & Actions */}
          <div className="flex items-center space-x-3">
            {/* Fault Simulator Trigger - Strictly PLATFORM_ADMIN only */}
            {currentUser.role === 'PLATFORM_ADMIN' && (
              <button
                onClick={() => setIsChaosOpen(true)}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-xl text-xs font-medium transition"
                title="Open Chaos & Fault Simulator"
              >
                <Zap className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Fault Simulator</span>
              </button>
            )}

            {/* Logged in User Pill */}
            <div className="hidden sm:flex items-center space-x-2 pl-2 border-l border-slate-800">
              <div className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 text-xs font-semibold">
                {currentUser.name.charAt(0)}
              </div>
              <div className="text-left">
                <div className="text-xs font-medium text-slate-200">{currentUser.name}</div>
                <div className="text-[10px] text-slate-400">{currentUser.email}</div>
              </div>
            </div>

            {/* Logout Button */}
            <button
              onClick={handleLogout}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-xl text-xs font-medium transition"
              title="Sign Out"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Role-Enforced Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* If Patient: Strictly only PatientPortal */}
        {currentUser.role === 'PATIENT' && <PatientPortal />}

        {/* If Doctor: Strictly only DoctorPortal */}
        {currentUser.role === 'DOCTOR' && <DoctorPortal />}

        {/* If Hospital Admin: Strictly only HospitalAdminPortal */}
        {currentUser.role === 'HOSPITAL_ADMIN' && <HospitalAdminPortal />}

        {/* If Platform Admin: Default to PlatformAdminPortal or selected audit scope */}
        {currentUser.role === 'PLATFORM_ADMIN' && (
          <>
            {activeAdminView === 'PLATFORM_ADMIN' && <PlatformAdminPortal />}
            {activeAdminView === 'HOSPITAL_ADMIN' && <HospitalAdminPortal />}
            {activeAdminView === 'DOCTOR' && <DoctorPortal />}
            {activeAdminView === 'PATIENT' && <PatientPortal />}
          </>
        )}
      </main>

      {/* Global Chaos Modal - PLATFORM_ADMIN only */}
      {currentUser.role === 'PLATFORM_ADMIN' && (
        <ChaosModal isOpen={isChaosOpen} onClose={() => setIsChaosOpen(false)} />
      )}
    </div>
  );
};
