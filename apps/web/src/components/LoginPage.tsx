import React, { useState } from 'react';
import { ApiService } from '../services/api.js';
import { User, UserRole } from '../types.js';
import {
  HeartPulse,
  Mail,
  Lock,
  ArrowRight,
  AlertCircle,
  ShieldCheck,
  User as UserIcon,
  Stethoscope,
  Building2,
  Shield,
  Loader2,
  Sparkles,
  CheckCircle2,
  ChevronDown,
} from 'lucide-react';

interface LoginPageProps {
  onLoginSuccess: (user: User) => void;
}

export type RoleTab = 'PLATFORM_ADMIN' | 'HOSPITAL_ADMIN' | 'DOCTOR' | 'PATIENT';

interface DemoAccountItem {
  id: string;
  name: string;
  email: string;
  password: string;
  hospitalName?: string;
  hospitalSlug?: string;
  specialty?: string;
  badge: string;
  description: string;
}

const DEMO_PLATFORM_ADMIN: DemoAccountItem = {
  id: 'platform-admin',
  name: 'Platform Administrator',
  email: 'platform.admin@health.org',
  password: 'Password123!',
  hospitalName: 'Global Platform (All Hospitals)',
  badge: 'Cross-Tenant Super Admin',
  description: 'Enterprise governance, hospital approvals, global configuration & audit logs',
};

const DEMO_HOSPITAL_ADMINS: DemoAccountItem[] = [
  {
    id: 'admin-apex',
    name: 'Apex Hospital Admin',
    email: 'admin@apexhealth.org',
    password: 'Password123!',
    hospitalName: 'Apex Regional Medical Center',
    hospitalSlug: 'apex-regional',
    badge: 'Apex Hospital Operations',
    description: 'Manages Orthopedics & Cardiology departments, doctors, and scheduling',
  },
  {
    id: 'admin-metro',
    name: 'Metro Hospital Admin',
    email: 'admin@metrohealth.org',
    password: 'Password123!',
    hospitalName: 'Metropolitan Health System',
    hospitalSlug: 'metropolitan-health',
    badge: 'Metro Hospital Operations',
    description: 'Manages Cardiovascular & Internal Medicine facilities and appointment slots',
  },
  {
    id: 'admin-riverside',
    name: 'Riverside Hospital Admin',
    email: 'admin@riversidehealth.org',
    password: 'Password123!',
    hospitalName: 'Riverside Community Hospital',
    hospitalSlug: 'riverside-community',
    badge: 'Riverside Hospital Operations',
    description: 'Manages Joint Reconstruction & Community Care operations and doctor rosters',
  },
];

const DEMO_DOCTORS: DemoAccountItem[] = [
  {
    id: 'doc-rao',
    name: 'Dr. Arvind Rao',
    email: 'dr.rao@apexhealth.org',
    password: 'Password123!',
    hospitalName: 'Apex Regional Medical Center',
    specialty: 'Orthopedics',
    badge: 'Orthopedic Surgery',
    description: '14 yrs exp • MD, MS Board Certified • Active Calendar & Slots',
  },
  {
    id: 'doc-patel',
    name: 'Dr. Maya Patel',
    email: 'dr.patel@apexhealth.org',
    password: 'Password123!',
    hospitalName: 'Apex Regional Medical Center',
    specialty: 'Cardiology',
    badge: 'Cardiovascular Institute',
    description: '11 yrs exp • MD, FACC Interventional Cardiology • Active Slots',
  },
  {
    id: 'doc-chen',
    name: 'Dr. Marcus Chen',
    email: 'dr.chen@metrohealth.org',
    password: 'Password123!',
    hospitalName: 'Metropolitan Health System',
    specialty: 'Cardiology',
    badge: 'Cardiovascular Care',
    description: '13 yrs exp • MD, FACC Electrophysiology • Active Slots',
  },
  {
    id: 'doc-jenkins',
    name: 'Dr. Elena Jenkins',
    email: 'dr.jenkins@metrohealth.org',
    password: 'Password123!',
    hospitalName: 'Metropolitan Health System',
    specialty: 'General Medicine',
    badge: 'Internal Medicine',
    description: '8 yrs exp • MD Board Certified Internal Medicine • Active Slots',
  },
  {
    id: 'doc-rostova',
    name: 'Dr. Anya Rostova',
    email: 'dr.rostova@riversidehealth.org',
    password: 'Password123!',
    hospitalName: 'Riverside Community Hospital',
    specialty: 'Orthopedics',
    badge: 'Orthopedics & Joint Recon',
    description: '10 yrs exp • MD Sports Medicine & Reconstruction • Active Slots',
  },
  {
    id: 'doc-kim',
    name: 'Dr. David Kim',
    email: 'dr.kim@riversidehealth.org',
    password: 'Password123!',
    hospitalName: 'Riverside Community Hospital',
    specialty: 'General Medicine',
    badge: 'Family Medicine',
    description: '12 yrs exp • MD Primary Care & Preventive Medicine • Active Slots',
  },
];

const DEMO_PATIENTS: DemoAccountItem[] = [
  {
    id: 'pat-jane',
    name: 'Jane Doe',
    email: 'jane.doe@example.com',
    password: 'Password123!',
    badge: 'Patient Profile',
    description: 'Active appointments • Pre-visit questionnaire submitted',
  },
  {
    id: 'pat-john',
    name: 'John Doe',
    email: 'patient.john@example.com',
    password: 'Password123!',
    badge: 'Patient Profile',
    description: 'Completed consultation history • Health records synchronized',
  },
  {
    id: 'pat-robert',
    name: 'Robert Taylor',
    email: 'robert.taylor@example.com',
    password: 'Password123!',
    badge: 'Patient Profile',
    description: 'Cardiology evaluation record • Intake submitted',
  },
  {
    id: 'pat-emily',
    name: 'Emily Watson',
    email: 'emily.watson@example.com',
    password: 'Password123!',
    badge: 'Patient Profile',
    description: 'Annual wellness checkup history • Preventive care records',
  },
  {
    id: 'pat-michael',
    name: 'Michael Chang',
    email: 'michael.chang@example.com',
    password: 'Password123!',
    badge: 'Patient Profile',
    description: 'Active consultations • Physical rehabilitation history',
  },
  {
    id: 'pat-sophia',
    name: 'Sophia Martinez',
    email: 'sophia.martinez@example.com',
    password: 'Password123!',
    badge: 'Patient Profile',
    description: 'Allergy & routine care history • Active prescriptions',
  },
];

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [activeTab, setActiveTab] = useState<RoleTab>('DOCTOR');
  const [selectedDoctorId, setSelectedDoctorId] = useState(DEMO_DOCTORS[0].id);
  const [selectedAdminId, setSelectedAdminId] = useState(DEMO_HOSPITAL_ADMINS[0].id);
  const [selectedPatientId, setSelectedPatientId] = useState(DEMO_PATIENTS[0].id);

  // Form input states
  const [email, setEmail] = useState(DEMO_DOCTORS[0].email);
  const [password, setPassword] = useState(DEMO_DOCTORS[0].password);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Handler for switching tabs
  const handleTabChange = (tab: RoleTab) => {
    setActiveTab(tab);
    setError(null);

    if (tab === 'PLATFORM_ADMIN') {
      setEmail(DEMO_PLATFORM_ADMIN.email);
      setPassword(DEMO_PLATFORM_ADMIN.password);
    } else if (tab === 'HOSPITAL_ADMIN') {
      const acc = DEMO_HOSPITAL_ADMINS.find((a) => a.id === selectedAdminId) || DEMO_HOSPITAL_ADMINS[0];
      setEmail(acc.email);
      setPassword(acc.password);
    } else if (tab === 'DOCTOR') {
      const acc = DEMO_DOCTORS.find((a) => a.id === selectedDoctorId) || DEMO_DOCTORS[0];
      setEmail(acc.email);
      setPassword(acc.password);
    } else if (tab === 'PATIENT') {
      const acc = DEMO_PATIENTS.find((a) => a.id === selectedPatientId) || DEMO_PATIENTS[0];
      setEmail(acc.email);
      setPassword(acc.password);
    }
  };

  // Handler for selecting specific account from dropdown
  const handleSelectAccount = (account: DemoAccountItem) => {
    setEmail(account.email);
    setPassword(account.password);
    setError(null);

    if (activeTab === 'HOSPITAL_ADMIN') setSelectedAdminId(account.id);
    if (activeTab === 'DOCTOR') setSelectedDoctorId(account.id);
    if (activeTab === 'PATIENT') setSelectedPatientId(account.id);
  };

  const executeLogin = async (targetEmail: string, targetPass: string) => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await ApiService.login(targetEmail.trim(), targetPass);
      onLoginSuccess(res.user);
    } catch (err: any) {
      setError(err.message || 'Authentication failed. Please verify credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }
    executeLogin(email, password);
  };

  // Get current active item for preview card
  const getCurrentActiveAccount = (): DemoAccountItem => {
    if (activeTab === 'PLATFORM_ADMIN') return DEMO_PLATFORM_ADMIN;
    if (activeTab === 'HOSPITAL_ADMIN') {
      return DEMO_HOSPITAL_ADMINS.find((a) => a.id === selectedAdminId) || DEMO_HOSPITAL_ADMINS[0];
    }
    if (activeTab === 'DOCTOR') {
      return DEMO_DOCTORS.find((a) => a.id === selectedDoctorId) || DEMO_DOCTORS[0];
    }
    return DEMO_PATIENTS.find((a) => a.id === selectedPatientId) || DEMO_PATIENTS[0];
  };

  const currentAccount = getCurrentActiveAccount();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center px-4 py-10 relative overflow-hidden">
      {/* Background ambient lighting */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[34rem] h-[34rem] bg-teal-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Brand Header */}
      <div className="text-center mb-6 relative z-10">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-teal-500 to-cyan-500 text-white shadow-xl shadow-teal-500/20 mb-3">
          <HeartPulse className="w-8 h-8" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
          AI.Prof Healthcare Platform
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-md mx-auto">
          Autonomous Clinical Intake, Dynamic Scheduling & Enterprise Multi-Tenant Operations
        </p>
      </div>

      {/* Main Login Card */}
      <div className="w-full max-w-xl bg-slate-900/90 border border-slate-800 rounded-2xl shadow-2xl backdrop-blur-xl p-6 sm:p-7 relative z-10">
        {/* Role Selection Tabs */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Select Role Portal
            </span>
            <div className="flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-slate-800/80 border border-slate-700/60 text-[11px] text-slate-300">
              <ShieldCheck className="w-3.5 h-3.5 text-teal-400" />
              <span>Multi-Tenant RBAC</span>
            </div>
          </div>

          {/* 4 Tabs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {/* Tab 1: Platform Admin */}
            <button
              type="button"
              id="tab-platform-admin"
              onClick={() => handleTabChange('PLATFORM_ADMIN')}
              className={`flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl border text-xs font-medium transition ${
                activeTab === 'PLATFORM_ADMIN'
                  ? 'bg-indigo-500/20 border-indigo-500/60 text-indigo-200 shadow-sm shadow-indigo-500/20'
                  : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
              }`}
            >
              <Shield className="w-3.5 h-3.5 text-indigo-400" />
              <span>Platform Admin</span>
            </button>

            {/* Tab 2: Hospital Admin */}
            <button
              type="button"
              id="tab-hospital-admin"
              onClick={() => handleTabChange('HOSPITAL_ADMIN')}
              className={`flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl border text-xs font-medium transition ${
                activeTab === 'HOSPITAL_ADMIN'
                  ? 'bg-amber-500/20 border-amber-500/60 text-amber-200 shadow-sm shadow-amber-500/20'
                  : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
              }`}
            >
              <Building2 className="w-3.5 h-3.5 text-amber-400" />
              <span>Hospital Admin</span>
            </button>

            {/* Tab 3: Doctor */}
            <button
              type="button"
              id="tab-doctor"
              onClick={() => handleTabChange('DOCTOR')}
              className={`flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl border text-xs font-medium transition ${
                activeTab === 'DOCTOR'
                  ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-200 shadow-sm shadow-cyan-500/20'
                  : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
              }`}
            >
              <Stethoscope className="w-3.5 h-3.5 text-cyan-400" />
              <span>Doctor</span>
            </button>

            {/* Tab 4: Patient */}
            <button
              type="button"
              id="tab-patient"
              onClick={() => handleTabChange('PATIENT')}
              className={`flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl border text-xs font-medium transition ${
                activeTab === 'PATIENT'
                  ? 'bg-teal-500/20 border-teal-500/60 text-teal-200 shadow-sm shadow-teal-500/20'
                  : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
              }`}
            >
              <UserIcon className="w-3.5 h-3.5 text-teal-400" />
              <span>Patient</span>
            </button>
          </div>
        </div>

        {/* Tenant / Account Selector Section */}
        <div className="mb-6 p-4 rounded-xl bg-slate-950/60 border border-slate-800/90">
          {activeTab === 'PLATFORM_ADMIN' ? (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-indigo-300 flex items-center space-x-1.5">
                  <Shield className="w-3.5 h-3.5" />
                  <span>Single Platform Super Admin</span>
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                  System Governance
                </span>
              </div>
              <p className="text-xs text-slate-400 mb-3">
                {DEMO_PLATFORM_ADMIN.description}
              </p>
              <button
                type="button"
                id="btn-platform-quick-signin"
                onClick={() => executeLogin(DEMO_PLATFORM_ADMIN.email, DEMO_PLATFORM_ADMIN.password)}
                disabled={isLoading}
                className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs rounded-xl shadow-lg shadow-indigo-600/25 transition"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>1-Click Sign In as Platform Administrator</span>
              </button>
            </div>
          ) : (
            <div>
              <label
                htmlFor="account-selector"
                className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center justify-between"
              >
                <span>
                  {activeTab === 'HOSPITAL_ADMIN' && 'Choose Hospital Admin Account & Facility:'}
                  {activeTab === 'DOCTOR' && 'Choose Doctor Account, Facility & Specialty:'}
                  {activeTab === 'PATIENT' && 'Choose Patient Profile:'}
                </span>
                {activeTab !== 'PATIENT' ? (
                  <span className="text-[11px] text-teal-400">Hospital Attributed</span>
                ) : (
                  <span className="text-[11px] text-teal-400">Patient Access</span>
                )}
              </label>

              {/* Custom Interactive Dropdown with Hospital & Specialty Badges */}
              <div className="relative mb-3">
                <button
                  type="button"
                  id="dropdown-toggle-btn"
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  className="w-full py-2.5 px-3 bg-slate-900 border border-slate-700/80 hover:border-slate-600 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 rounded-xl text-xs sm:text-sm text-slate-100 flex items-center justify-between transition cursor-pointer"
                >
                  <div className="flex items-center space-x-2 truncate">
                    <span className="font-semibold text-slate-100">{currentAccount.name}</span>
                    {activeTab !== 'PATIENT' && currentAccount.hospitalName && (
                      <span className="text-[11px] text-teal-400 truncate">({currentAccount.hospitalName})</span>
                    )}
                    {currentAccount.specialty && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 font-normal shrink-0">
                        {currentAccount.specialty}
                      </span>
                    )}
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                      isDropdownOpen ? 'rotate-180 text-teal-400' : ''
                    }`}
                  />
                </button>

                {/* Dropdown Options List */}
                {isDropdownOpen && (
                  <div
                    id="dropdown-options-container"
                    className="mt-1.5 w-full bg-slate-900/95 border border-slate-700 rounded-xl shadow-2xl backdrop-blur-md overflow-hidden max-h-60 overflow-y-auto divide-y divide-slate-800 z-50"
                  >
                    {activeTab === 'HOSPITAL_ADMIN' &&
                      DEMO_HOSPITAL_ADMINS.map((acc) => (
                        <button
                          key={acc.id}
                          type="button"
                          onClick={() => {
                            handleSelectAccount(acc);
                            setIsDropdownOpen(false);
                          }}
                          className={`w-full text-left p-2.5 flex items-center justify-between hover:bg-slate-800/80 transition ${
                            acc.id === currentAccount.id ? 'bg-amber-950/30 border-l-2 border-amber-400' : ''
                          }`}
                        >
                          <div>
                            <div className="text-xs font-semibold text-slate-100">{acc.name}</div>
                            <div className="text-[11px] text-slate-400">{acc.email}</div>
                          </div>
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30 whitespace-nowrap ml-2">
                            {acc.hospitalName}
                          </span>
                        </button>
                      ))}

                    {activeTab === 'DOCTOR' &&
                      DEMO_DOCTORS.map((doc) => (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => {
                            handleSelectAccount(doc);
                            setIsDropdownOpen(false);
                          }}
                          className={`w-full text-left p-2.5 flex items-center justify-between hover:bg-slate-800/80 transition ${
                            doc.id === currentAccount.id ? 'bg-cyan-950/30 border-l-2 border-cyan-400' : ''
                          }`}
                        >
                          <div>
                            <div className="flex items-center space-x-2">
                              <span className="text-xs font-semibold text-slate-100">{doc.name}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
                                {doc.specialty}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400">{doc.description}</div>
                          </div>
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 whitespace-nowrap ml-2">
                            {doc.hospitalName}
                          </span>
                        </button>
                      ))}

                    {activeTab === 'PATIENT' &&
                      DEMO_PATIENTS.map((pat) => (
                        <button
                          key={pat.id}
                          type="button"
                          onClick={() => {
                            handleSelectAccount(pat);
                            setIsDropdownOpen(false);
                          }}
                          className={`w-full text-left p-2.5 flex items-center justify-between hover:bg-slate-800/80 transition ${
                            pat.id === currentAccount.id ? 'bg-teal-950/30 border-l-2 border-teal-400' : ''
                          }`}
                        >
                          <div>
                            <div className="text-xs font-semibold text-slate-100">{pat.name}</div>
                            <div className="text-[11px] text-slate-400">{pat.description}</div>
                          </div>
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-teal-500/10 text-teal-300 border border-teal-500/30 whitespace-nowrap ml-2">
                            {pat.badge}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>

              {/* Active Account Identity Card & 1-Click Action */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-slate-900/90 border border-slate-800">
                <div className="space-y-0.5">
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-semibold text-slate-100">{currentAccount.name}</span>
                    {activeTab !== 'PATIENT' && currentAccount.hospitalName ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                        {currentAccount.hospitalName}
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-950 text-teal-300 border border-teal-800">
                        {currentAccount.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">{currentAccount.description}</p>
                </div>
                <button
                  type="button"
                  id="btn-quick-signin"
                  onClick={() => executeLogin(currentAccount.email, currentAccount.password)}
                  disabled={isLoading}
                  className="shrink-0 flex items-center justify-center space-x-1.5 py-2 px-3 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-500 hover:to-cyan-500 text-white font-medium text-xs rounded-lg shadow-md shadow-teal-600/20 transition"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>1-Click Sign In</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mb-5 flex items-start space-x-2.5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* Manual Credentials Fallback Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              Manual / Editable Credentials
            </span>
            <span className="text-[10px] text-slate-500">Auto-filled from selection</span>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                id="input-email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@hospital.org"
                className="w-full pl-10 pr-4 py-2 bg-slate-950/70 border border-slate-800 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 rounded-xl text-xs sm:text-sm text-slate-100 placeholder-slate-500 transition outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                id="input-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full pl-10 pr-4 py-2 bg-slate-950/70 border border-slate-800 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 rounded-xl text-xs sm:text-sm text-slate-100 placeholder-slate-500 transition outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            id="btn-submit-login"
            disabled={isLoading}
            className="w-full mt-2 flex items-center justify-center space-x-2 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 font-medium text-xs sm:text-sm rounded-xl border border-slate-700/80 transition"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Authenticating with JWT...</span>
              </>
            ) : (
              <>
                <span>Sign In with Form Credentials</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Scope Notification Bar */}
        <div className="mt-5 pt-4 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center space-x-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-teal-400" />
            {activeTab !== 'PATIENT' && currentAccount.hospitalName ? (
              <span>Active Tenant: <strong className="text-slate-200">{currentAccount.hospitalName}</strong></span>
            ) : (
              <span>Scope: <strong className="text-teal-300">Patient Access Portal</strong></span>
            )}
          </div>
          <span className="text-slate-500">Password: <code className="text-teal-400 font-mono">Password123!</code></span>
        </div>
      </div>

      {/* Security Footer */}
      <div className="mt-6 text-center text-xs text-slate-500">
        <p>Enterprise Multi-Tenant Isolation & Role-Based Access Control Active</p>
      </div>
    </div>
  );
};
