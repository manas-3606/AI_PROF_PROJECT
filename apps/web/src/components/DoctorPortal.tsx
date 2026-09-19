import React, { useState, useEffect } from 'react';
import { ApiService } from '../services/api.js';
import {
  UserCheck, Clock, FileText, CheckCircle, AlertCircle, ShieldCheck,
  Calendar, AlertTriangle, User, Plus, RefreshCw, XCircle
} from 'lucide-react';

export const DoctorPortal: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'appointments' | 'calendar' | 'availability' | 'blockedTime' | 'questionnaires'>('appointments');
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [selectedAppt, setSelectedAppt] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Add blocked time form
  const [showAddBlocked, setShowAddBlocked] = useState(false);
  const [blockedReason, setBlockedReason] = useState('');
  const [blockedStart, setBlockedStart] = useState('');
  const [blockedEnd, setBlockedEnd] = useState('');

  const loadData = async () => {
    try {
      setLoading(true);
      const data = await ApiService.getDoctorDashboard();
      setDashboardData(data);
      if (data?.appointments?.length > 0 && !selectedAppt) {
        setSelectedAppt(data.appointments[0]);
      }
    } catch (e) {
      console.error('Failed to load doctor dashboard:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
  }, []);

  const doctor = dashboardData?.doctor;
  const appointments = dashboardData?.appointments || [];
  const calendarSlots = dashboardData?.calendar || [];
  const availability = dashboardData?.availability || [];
  const blockedTime = dashboardData?.blockedTime || [];
  const preVisitResponses = dashboardData?.preVisitResponses || [];
  const questionTextMap = dashboardData?.questionTextMap || {};

  const getQuestionLabel = (key: string, questionnaire?: any) => {
    if (questionTextMap[key]) return questionTextMap[key];
    if (questionnaire?.questions) {
      const found = questionnaire.questions.find((q: any) => q.id === key);
      if (found?.text) return found.text;
    }
    return key;
  };

  const formatAnswerValue = (val: any) => {
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (val === null || val === undefined || val === '') return 'N/A';
    return String(val);
  };

  return (
    <div className="space-y-6">
      {/* Doctor Header Banner */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-teal-500 to-emerald-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-teal-500/20">
            {doctor?.name ? doctor.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2) : 'DR'}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-xl font-bold text-white">{doctor?.name || 'Dr. Arvind Rao'}</h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                {doctor?.status || 'ACTIVE'}
              </span>
            </div>
            <p className="text-xs text-teal-400 font-medium">
              {doctor?.specialty || 'Orthopedics & Sports Medicine'} • {doctor?.hospital?.name || 'Apex Regional Medical Center'}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {doctor?.appointmentDurationMinutes || 30}-minute slots • Role-gated Doctor Access
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="text-right px-4 py-2 rounded-xl bg-slate-900 border border-slate-800">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Today's Appointments</span>
            <span className="text-lg font-bold text-white">{appointments.length}</span>
          </div>
          <button
            onClick={loadData}
            className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-xl border border-slate-800 transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-900/90 rounded-2xl border border-slate-800 text-xs">
        {[
          { id: 'appointments', label: "Today's & Upcoming Schedule", icon: Calendar, badge: appointments.length },
          { id: 'calendar', label: 'Calendar & Slot Grid', icon: Clock },
          { id: 'availability', label: 'Working Hours', icon: UserCheck },
          { id: 'blockedTime', label: 'Blocked Periods', icon: XCircle, badge: blockedTime.length },
          { id: 'questionnaires', label: 'Authorized Pre-Visit Responses', icon: FileText, badge: preVisitResponses.length },
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

      {/* Tab: Appointments & Selected Detail View */}
      {activeTab === 'appointments' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
            <h3 className="text-base font-semibold text-white">Confirmed Patient Schedule</h3>
            <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
              {appointments.length === 0 ? (
                <p className="text-xs text-slate-500">No appointments booked for this doctor.</p>
              ) : (
                appointments.map((a: any) => {
                  const isSelected = selectedAppt?.id === a.id;
                  const hasUrgent = (a.questionnaireResponses || []).some((r: any) => r.flaggedUrgent);
                  return (
                    <div
                      key={a.id}
                      onClick={() => setSelectedAppt(a)}
                      className={`p-3.5 rounded-xl border text-xs cursor-pointer transition ${
                        isSelected
                          ? 'bg-teal-950/40 border-teal-500 shadow-md'
                          : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-white text-sm">{a.patient?.name}</span>
                            {hasUrgent && (
                              <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold border border-rose-500/40 flex items-center space-x-1">
                                <AlertTriangle className="w-3 h-3" />
                                <span>URGENT TRIAGE</span>
                              </span>
                            )}
                          </div>
                          <p className="text-teal-400 mt-1">{a.reason}</p>
                          <span className="text-[11px] text-slate-400 block mt-0.5">
                            {new Date(a.startTime).toLocaleString()} ({doctor?.appointmentDurationMinutes || 30} mins)
                          </span>
                        </div>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          a.status === 'Confirmed' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                        }`}>
                          {a.status}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Appointment Detail View */}
          <div className="lg:col-span-5 glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
            <h3 className="text-base font-semibold text-white flex items-center space-x-2">
              <FileText className="w-4 h-4 text-teal-400" />
              <span>Appointment Detail & Patient Dossier</span>
            </h3>

            {selectedAppt ? (
              <div className="space-y-4 text-xs">
                <div className="p-3.5 bg-slate-900 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Patient:</span>
                    <span className="text-white font-semibold">{selectedAppt.patient?.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Status:</span>
                    <span className="text-emerald-400 font-semibold">{selectedAppt.status}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Scheduled Time:</span>
                    <span className="text-white font-mono">{new Date(selectedAppt.startTime).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Chief Complaint:</span>
                    <span className="text-teal-300 font-medium">{selectedAppt.reason}</span>
                  </div>
                </div>

                {/* Pre-visit responses for this appointment */}
                <div>
                  <h4 className="font-semibold text-slate-300 mb-2">Pre-Visit Questionnaire Responses:</h4>
                  {(selectedAppt.questionnaireResponses || []).length === 0 ? (
                    <p className="text-[11px] text-slate-500">No questionnaire submitted for this appointment yet.</p>
                  ) : (
                    selectedAppt.questionnaireResponses.map((r: any) => {
                      let answers: Record<string, any> = {};
                      try {
                        answers = JSON.parse(r.answersJson || '{}');
                      } catch {}
                      return (
                        <div key={r.id} className="p-3 bg-slate-900 rounded-xl border border-slate-800 space-y-2">
                          {r.flaggedUrgent && (
                            <div className="p-2 bg-rose-500/20 border border-rose-500/40 rounded-lg text-rose-300 font-semibold text-[11px] flex items-center space-x-1.5">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>Flagged: {r.flaggedReason}</span>
                            </div>
                          )}
                          <div className="space-y-1.5 pt-1">
                            {Object.entries(answers).map(([k, v]) => (
                              <div key={k} className="flex justify-between items-start text-[11px] gap-2">
                                <span className="text-slate-400 font-medium text-left">{getQuestionLabel(k, r.questionnaire)}:</span>
                                <span className="text-white font-semibold text-right shrink-0">{formatAnswerValue(v)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Select an appointment to inspect patient pre-visit responses.</p>
            )}
          </div>
        </div>
      )}

      {/* Tab: Calendar */}
      {activeTab === 'calendar' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Doctor Calendar Slots</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 max-h-[500px] overflow-y-auto pr-1">
            {calendarSlots.map((s: any) => (
              <div
                key={s.id}
                className={`p-3 rounded-xl border text-xs ${
                  s.isBooked
                    ? 'bg-rose-950/20 border-rose-500/30 text-rose-300'
                    : 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
                }`}
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="font-bold">{s.isBooked ? 'BOOKED' : 'AVAILABLE'}</span>
                  <span className="text-[10px] text-slate-400">{new Date(s.startTime).toLocaleDateString()}</span>
                </div>
                <p className="font-mono text-white text-[11px]">
                  {new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -{' '}
                  {new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Availability */}
      {activeTab === 'availability' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Configured Weekly Working Hours</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {availability.map((wh: any) => {
              const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
              return (
                <div key={wh.id} className="p-4 bg-slate-900 rounded-xl border border-slate-800 text-xs">
                  <span className="font-bold text-white text-sm block">{days[wh.dayOfWeek]}</span>
                  <span className="text-teal-400 font-mono mt-1 block">
                    {wh.startTime} - {wh.endTime}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab: Blocked Time */}
      {activeTab === 'blockedTime' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-base font-semibold text-white">Doctor Blocked Periods & Leave</h3>
          </div>

          <div className="space-y-2">
            {blockedTime.length === 0 ? (
              <p className="text-xs text-slate-500">No blocked periods configured. Full working hours available.</p>
            ) : (
              blockedTime.map((b: any) => (
                <div key={b.id} className="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs flex justify-between items-center">
                  <div>
                    <span className="font-bold text-amber-300">{b.reason || 'Doctor Busy / Unavailable'}</span>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {new Date(b.startTime).toLocaleString()} to {new Date(b.endTime).toLocaleString()}
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold">
                    BLOCKED
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Tab: Questionnaires */}
      {activeTab === 'questionnaires' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">All Submitted Pre-Visit Responses</h3>
          <div className="space-y-3">
            {preVisitResponses.map((r: any) => {
              let answers: Record<string, any> = {};
              try {
                answers = JSON.parse(r.answersJson || '{}');
              } catch {}
              return (
                <div key={r.id} className="p-4 bg-slate-900 rounded-xl border border-slate-800 text-xs space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-white text-sm">{r.appointment?.patient?.name || 'Patient'}</span>
                    {r.flaggedUrgent ? (
                      <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 font-bold text-[10px] border border-rose-500/30 flex items-center space-x-1">
                        <AlertTriangle className="w-3 h-3" />
                        <span>URGENT: {r.flaggedReason}</span>
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[10px]">
                        REVIEWED
                      </span>
                    )}
                  </div>
                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 space-y-1.5">
                    {Object.entries(answers).map(([k, v]) => (
                      <div key={k} className="flex justify-between items-start text-[11px] gap-2">
                        <span className="text-slate-400 font-medium text-left">{getQuestionLabel(k, r.questionnaire)}:</span>
                        <span className="text-white font-semibold text-right shrink-0">{formatAnswerValue(v)}</span>
                      </div>
                    ))}
                  </div>
                  <span className="text-[10px] text-slate-500 block">Submitted: {new Date(r.submittedAt).toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
