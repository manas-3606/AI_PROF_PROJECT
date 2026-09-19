import React, { useState, useEffect, useCallback } from 'react';
import { ApiService } from '../services/api.js';
import { Appointment, Questionnaire } from '../types.js';
import {
  Calendar, Clock, CheckCircle2, AlertCircle, FileText, Settings, ShieldCheck, X,
  User, Bell, MessageSquare, Mic, HeartPulse, Sparkles
} from 'lucide-react';
import { VoiceHud } from './VoiceHud.js';

export const PatientPortal: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'home' | 'appointments' | 'questionnaires' | 'preferences' | 'profile'>('home');
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [questionnaires, setQuestionnaires] = useState<Questionnaire[]>([]);
  const [activeQuestionnaire, setActiveQuestionnaire] = useState<Questionnaire | null>(null);
  const [questionnaireAnswers, setQuestionnaireAnswers] = useState<Record<string, any>>({});
  const [activeAppointmentForQ, setActiveAppointmentForQ] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async (isBackground = false) => {
    try {
      if (!isBackground) setLoading(true);
      const [dash, qData] = await Promise.all([
        ApiService.getPatientDashboard(),
        ApiService.getQuestionnaires(),
      ]);
      setDashboardData(dash);
      setQuestionnaires(qData);
    } catch (e) {
      console.error('Failed to load patient dashboard:', e);
    } finally {
      if (!isBackground) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(false);
    const interval = setInterval(() => loadData(true), 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  const patient = dashboardData?.patient;
  const appointments: Appointment[] = dashboardData?.appointments || [];
  const upcoming = dashboardData?.upcomingAppointments || [];
  const historical = dashboardData?.historicalAppointments || [];

  const handleOpenQuestionnaire = (appt: Appointment) => {
    const q = questionnaires[0];
    if (q) {
      setActiveQuestionnaire(q);
      setActiveAppointmentForQ(appt.id);
      setQuestionnaireAnswers({});
    }
  };

  const handleSubmitQuestionnaire = async () => {
    if (!activeQuestionnaire || !activeAppointmentForQ) return;
    try {
      await ApiService.submitQuestionnaire({
        questionnaireId: activeQuestionnaire.id,
        appointmentId: activeAppointmentForQ,
        patientId: patient?.id || appointments[0]?.patientId || 'DEFAULT',
        responses: questionnaireAnswers,
      });
      setActiveQuestionnaire(null);
      await loadData();
      alert('Questionnaire submitted successfully to your doctor!');
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
      {/* Left Column: Embedded Real-Time Voice + Chat Assistant (PRD Phase A) */}
      <div className="lg:col-span-5 flex flex-col sticky top-4 self-start z-10">
        <VoiceHud onAppointmentBooked={loadData} />
      </div>

      {/* Right Column: Role-Scoped Patient Portal Views */}
      <div className="lg:col-span-7 space-y-6">
        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-900/90 rounded-2xl border border-slate-800 text-xs">
          {[
            { id: 'home', label: 'Care Home', icon: HeartPulse },
            { id: 'appointments', label: 'My Appointments', icon: Calendar, badge: appointments.length },
            { id: 'questionnaires', label: 'Pre-Visit Intake', icon: FileText },
            { id: 'preferences', label: 'Preferences', icon: Settings },
            { id: 'profile', label: 'Profile', icon: User },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center space-x-1.5 px-3 py-2 rounded-xl font-medium transition ${
                  isActive
                    ? 'bg-teal-600 text-white shadow-md shadow-teal-600/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                {typeof tab.badge === 'number' && tab.badge > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-teal-400/20 text-teal-300 font-bold ml-1">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab: Home */}
        {activeTab === 'home' && (
          <div className="space-y-6">
            <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-white">Welcome, {patient?.name || 'John Doe'}</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Your autonomous health access portal is active. You can speak or type to schedule visits.
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-teal-500/20 text-teal-300 border border-teal-500/30">
                  PATIENT ACCESS
                </span>
              </div>

              {upcoming.length > 0 ? (
                <div className="mt-4 p-4 bg-teal-950/40 border border-teal-500/40 rounded-xl space-y-2">
                  <span className="text-[10px] text-teal-400 font-bold uppercase tracking-wider block">Upcoming Visit</span>
                  <div className="flex justify-between items-center text-xs">
                    <div>
                      <span className="font-bold text-white text-sm">{upcoming[0].doctor?.name}</span>
                      <p className="text-slate-300">{upcoming[0].doctor?.specialty} • {upcoming[0].hospital?.name}</p>
                      <p className="text-teal-400 font-mono mt-1">{new Date(upcoming[0].startTime).toLocaleString()}</p>
                    </div>
                    <span className="px-2.5 py-1 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
                      CONFIRMED
                    </span>
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-slate-900 rounded-xl border border-slate-800 text-xs text-slate-400">
                  No upcoming appointments. Click the microphone on the left or type your request to book a visit.
                </div>
              )}
            </div>

            {/* Quick Metrics */}
            <div className="grid grid-cols-2 gap-4">
              <div className="glass-card p-4 rounded-xl border border-slate-800">
                <span className="text-xs text-slate-400 block">Total Visited Records</span>
                <span className="text-2xl font-bold text-white mt-1 block">{appointments.length}</span>
              </div>
              <div className="glass-card p-4 rounded-xl border border-slate-800">
                <span className="text-xs text-slate-400 block">EHR Verification Status</span>
                <span className="text-sm font-bold text-emerald-400 mt-2 block flex items-center space-x-1">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Synchronized</span>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Tab: Appointments (Upcoming & Historical) */}
        {activeTab === 'appointments' && (
          <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
            <h3 className="text-base font-semibold text-white">My Appointments</h3>
            {appointments.length === 0 ? (
              <p className="text-xs text-slate-500">No appointments scheduled.</p>
            ) : (
              <div className="space-y-3">
                {appointments.map((a: any) => (
                  <div key={a.id} className="p-4 bg-slate-900 rounded-xl border border-slate-800 text-xs space-y-2">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="font-bold text-white text-sm">{a.doctor?.name}</span>
                        <p className="text-teal-400">{a.doctor?.specialty} • {a.hospital?.name}</p>
                        <p className="text-slate-400 font-mono mt-1">{new Date(a.startTime).toLocaleString()}</p>
                        <p className="text-slate-300 mt-1">Reason: {a.reason}</p>
                      </div>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        a.status === 'Confirmed' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                      }`}>
                        {a.status}
                      </span>
                    </div>

                    <div className="pt-2 border-t border-slate-800/80 flex justify-between items-center">
                      <span className="text-[11px] text-slate-400">
                        {a.questionnaireResponses?.length > 0 ? 'Pre-Visit Intake: Completed' : 'Pre-Visit Intake: Pending'}
                      </span>
                      {a.questionnaireResponses?.length === 0 && (
                        <button
                          onClick={() => handleOpenQuestionnaire(a)}
                          className="px-2.5 py-1 bg-teal-600 hover:bg-teal-500 text-white rounded text-[11px] font-semibold"
                        >
                          Complete Intake
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab: Questionnaires */}
        {activeTab === 'questionnaires' && (
          <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
            <h3 className="text-base font-semibold text-white">Pre-Visit Questionnaires</h3>
            <p className="text-xs text-slate-400">Questionnaires assigned to your care schedule.</p>
            <div className="space-y-3">
              {questionnaires.map((q) => (
                <div key={q.id} className="p-4 bg-slate-900 rounded-xl border border-slate-800 text-xs space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-white text-sm">{q.title}</span>
                    <span className="text-teal-400">{q.questions.length} questions</span>
                  </div>
                  <p className="text-slate-400">{q.description}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab: Preferences */}
        {activeTab === 'preferences' && (
          <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4 text-xs">
            <h3 className="text-base font-semibold text-white">Notification & Scheduling Preferences</h3>
            <div className="space-y-3">
              <div className="p-3 bg-slate-900 rounded-xl border border-slate-800 flex justify-between items-center">
                <div>
                  <span className="font-semibold text-white block">Preferred Communication Channel</span>
                  <span className="text-slate-400 text-[11px]">Receive updates via Voice Call & SMS</span>
                </div>
                <span className="px-2 py-0.5 rounded bg-teal-500/20 text-teal-300 font-bold">VOICE + SMS</span>
              </div>
              <div className="p-3 bg-slate-900 rounded-xl border border-slate-800 flex justify-between items-center">
                <div>
                  <span className="font-semibold text-white block">24h Appointment Reminder</span>
                  <span className="text-slate-400 text-[11px]">Automated notification scheduled 1 day before visit</span>
                </div>
                <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold">ENABLED</span>
              </div>
            </div>
          </div>
        )}

        {/* Tab: Profile */}
        {activeTab === 'profile' && (
          <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4 text-xs">
            <h3 className="text-base font-semibold text-white">Patient Profile Details</h3>
            <div className="p-4 bg-slate-900 rounded-xl border border-slate-800 space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-400">Full Name:</span>
                <span className="text-white font-semibold">{patient?.name || 'John Doe'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Email:</span>
                <span className="text-white font-mono">{patient?.email || 'john.doe@example.com'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Phone:</span>
                <span className="text-white font-mono">{patient?.phone || '+1-555-0199'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Record ID:</span>
                <span className="text-cyan-400 font-mono">{patient?.id}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pre-Visit Questionnaire Modal */}
      {activeQuestionnaire && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-lg font-bold text-white">{activeQuestionnaire.title}</h3>
                <p className="text-xs text-slate-400 mt-1">{activeQuestionnaire.description}</p>
              </div>
              <button
                onClick={() => setActiveQuestionnaire(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {activeQuestionnaire.questions.map((q) => (
                <div key={q.id} className="space-y-2">
                  <label className="block text-sm font-medium text-slate-200">
                    {q.text} {q.required && <span className="text-rose-400">*</span>}
                  </label>

                  {q.type === 'yes_no' ? (
                    <div className="flex space-x-4">
                      {['Yes', 'No'].map((val) => (
                        <label key={val} className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="radio"
                            name={q.id}
                            value={val}
                            checked={questionnaireAnswers[q.id] === val}
                            onChange={(e) =>
                              setQuestionnaireAnswers({ ...questionnaireAnswers, [q.id]: e.target.value })
                            }
                            className="text-teal-500 focus:ring-teal-500"
                          />
                          <span>{val}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={questionnaireAnswers[q.id] || ''}
                      onChange={(e) =>
                        setQuestionnaireAnswers({ ...questionnaireAnswers, [q.id]: e.target.value })
                      }
                      placeholder="Type your response here..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-teal-500"
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-end space-x-3 pt-4 border-t border-slate-800">
              <button
                onClick={() => setActiveQuestionnaire(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-xl transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitQuestionnaire}
                className="px-5 py-2 text-xs font-semibold bg-teal-600 hover:bg-teal-500 text-white rounded-xl shadow-lg shadow-teal-600/30 transition"
              >
                Submit Responses
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
