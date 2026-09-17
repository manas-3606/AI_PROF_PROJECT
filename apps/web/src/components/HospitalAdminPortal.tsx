import React, { useState, useEffect } from 'react';
import { ApiService } from '../services/api.js';
import {
  Building2, Users, Calendar, Activity, Link2, ShieldCheck, CheckCircle2,
  FileText, Clock, Bot, GitBranch, Layers, UserPlus, Search, AlertCircle
} from 'lucide-react';

export const HospitalAdminPortal: React.FC = () => {
  const [activeTab, setActiveTab] = useState<
    'overview' | 'appointments' | 'doctors' | 'calendars' | 'questionnaires' |
    'aiActivity' | 'integrations' | 'workflows' | 'staff'
  >('overview');

  const [dashboardData, setDashboardData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    try {
      setLoading(true);
      const data = await ApiService.getHospitalAdminDashboard();
      setDashboardData(data);
    } catch (e) {
      console.error('Failed to load hospital admin dashboard:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
  }, []);

  const hospital = dashboardData?.hospital;

  return (
    <div className="space-y-6">
      {/* Hospital Overview Header */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-teal-600 to-cyan-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-teal-600/20">
            <Building2 className="w-7 h-7" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-xl font-bold text-white">{hospital?.name || 'Apex Regional Medical Center'}</h2>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                {hospital?.status || 'APPROVED'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {hospital?.address}, {hospital?.city} • Hours: {hospital?.operatingHours}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="px-3.5 py-1.5 bg-teal-950/60 rounded-xl border border-teal-500/30 text-xs text-teal-300 flex items-center space-x-1.5 font-medium">
            <ShieldCheck className="w-4 h-4 text-teal-400" />
            <span>Tenant Isolated (Org ID: {hospital?.id?.slice(0, 8)})</span>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-900/90 rounded-2xl border border-slate-800 text-xs">
        {[
          { id: 'overview', label: 'Overview', icon: Building2 },
          { id: 'appointments', label: 'Appointments', icon: Calendar, badge: dashboardData?.appointments?.length },
          { id: 'doctors', label: 'Doctors', icon: Users, badge: dashboardData?.doctors?.length },
          { id: 'calendars', label: 'Calendars & Availability', icon: Clock },
          { id: 'questionnaires', label: 'Questionnaires', icon: FileText, badge: dashboardData?.questionnaires?.length },
          { id: 'aiActivity', label: 'AI Activity', icon: Bot },
          { id: 'integrations', label: 'EHR Integrations', icon: GitBranch },
          { id: 'workflows', label: 'Workflows', icon: Layers },
          { id: 'staff', label: 'Staff & Access', icon: UserPlus },
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

      {/* Tab: Overview */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Active Doctors</span>
              <span className="text-2xl font-bold text-white">{dashboardData?.doctors?.length || 0}</span>
              <span className="text-[11px] text-teal-400 block mt-1">Managed calendars active</span>
            </div>
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Hospital Bookings</span>
              <span className="text-2xl font-bold text-white">{dashboardData?.appointments?.length || 0}</span>
              <span className="text-[11px] text-emerald-400 block mt-1">EHR Synchronized</span>
            </div>
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Configured Questionnaires</span>
              <span className="text-2xl font-bold text-white">{dashboardData?.questionnaires?.length || 0}</span>
              <span className="text-[11px] text-cyan-400 block mt-1">Hierarchical resolution</span>
            </div>
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Staff Members</span>
              <span className="text-2xl font-bold text-white">{dashboardData?.staff?.length || 0}</span>
              <span className="text-[11px] text-slate-400 block mt-1">Role-gated access</span>
            </div>
          </div>

          <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-3">
            <h3 className="text-base font-semibold text-white">Hospital Configuration & Policies</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                <span className="text-slate-400 block">Operating Hours</span>
                <span className="text-white font-semibold mt-1 block">{hospital?.operatingHours}</span>
              </div>
              <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                <span className="text-slate-400 block">Contact Info</span>
                <span className="text-white font-semibold mt-1 block">{hospital?.contactEmail} • {hospital?.contactPhone}</span>
              </div>
              <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                <span className="text-slate-400 block">Integration Status</span>
                <span className="text-emerald-400 font-semibold mt-1 block flex items-center space-x-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Mock EHR Active & Verified</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Appointments */}
      {activeTab === 'appointments' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Hospital Appointments</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Patient</th>
                  <th className="p-3">Doctor</th>
                  <th className="p-3">Scheduled Time</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.appointments || []).map((a: any) => (
                  <tr key={a.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-semibold text-white">{a.patient?.name}</td>
                    <td className="p-3 text-teal-400">{a.doctor?.name}</td>
                    <td className="p-3 text-slate-400">{new Date(a.startTime).toLocaleString()}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        a.status === 'Confirmed'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : a.status === 'Cancelled'
                          ? 'bg-rose-500/20 text-rose-300'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}>
                        {a.status}
                      </span>
                    </td>
                    <td className="p-3 text-slate-400">{a.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Doctors */}
      {activeTab === 'doctors' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Hospital Medical Staff</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Doctor Name</th>
                  <th className="p-3">Department</th>
                  <th className="p-3">Specialty</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Working Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.doctors || []).map((d: any) => (
                  <tr key={d.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-semibold text-white">{d.name}</td>
                    <td className="p-3 text-slate-300">{d.department}</td>
                    <td className="p-3 text-teal-400">{d.specialty}</td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
                        {d.status}
                      </span>
                    </td>
                    <td className="p-3 text-slate-400">
                      {(d.calendar?.workingHours || []).length > 0
                        ? `${d.calendar.workingHours.length} days/week (${d.calendar.workingHours[0].startTime}-${d.calendar.workingHours[0].endTime})`
                        : 'Configured'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Calendars & Availability */}
      {activeTab === 'calendars' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Doctor Calendars & Configured Working Hours</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(dashboardData?.calendars || []).map((c: any) => (
              <div key={c.id} className="p-4 bg-slate-900 rounded-xl border border-slate-800 space-y-2 text-xs">
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-white text-sm">{c.name}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-teal-500/20 text-teal-300 font-bold">
                    {c.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
                <p className="text-slate-400">Doctor: {c.doctor?.name || 'Assigned'}</p>
                <div className="pt-2 border-t border-slate-800 flex justify-between text-[11px] text-slate-500">
                  <span>Slot Duration: {c.doctor?.appointmentDurationMinutes || 30} mins</span>
                  <span>Isolation: Tenant Scoped</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Questionnaires */}
      {activeTab === 'questionnaires' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Pre-Visit Intake Questionnaires</h3>
          <div className="space-y-3">
            {(dashboardData?.questionnaires || []).map((q: any) => (
              <div key={q.id} className="p-4 bg-slate-900 rounded-xl border border-slate-800 text-xs space-y-2">
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-white text-sm">{q.title}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-teal-500/20 text-teal-300 font-bold">
                    {q.questions?.length || 0} Questions Configured
                  </span>
                </div>
                <p className="text-slate-400">{q.description}</p>
                <div className="pt-2 border-t border-slate-800/80 flex flex-wrap gap-2">
                  {(q.questions || []).map((qu: any, i: number) => (
                    <span key={qu.id} className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-[11px]">
                      Q{i + 1}: {qu.questionText} ({qu.type})
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: AI Activity */}
      {activeTab === 'aiActivity' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">AI Operations & Conversational Intake</h3>
          <p className="text-xs text-slate-400">Recent AI activity and intake interactions scoped to this hospital tenant.</p>
          <div className="space-y-2">
            {(dashboardData?.integrationActivity || []).slice(0, 10).map((op: any) => (
              <div key={op.id} className="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs flex justify-between items-center">
                <div>
                  <span className="font-bold text-teal-300 font-mono">{op.eventType}</span>
                  <p className="text-[11px] text-slate-300 mt-0.5">{op.message}</p>
                </div>
                <span className="text-[10px] text-slate-500">{new Date(op.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Integrations */}
      {activeTab === 'integrations' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Healthcare EHR Integration Status</h3>
          <div className="p-4 bg-emerald-950/20 border border-emerald-500/30 rounded-xl text-xs space-y-2">
            <div className="flex items-center space-x-2 text-emerald-400 font-semibold">
              <CheckCircle2 className="w-4 h-4" />
              <span>EHR Connector Online</span>
            </div>
            <p className="text-slate-300">
              Mock EHR Connector mapped and synchronized via Section 12-13 HealthcareConnector interface.
            </p>
            <div className="pt-2 text-[11px] text-slate-500 flex gap-4">
              <span>Connector: MockEhrConnector</span>
              <span>Verification Policy: Proactive query verification</span>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Workflows */}
      {activeTab === 'workflows' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Hospital Workflow Executions</h3>
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {(dashboardData?.workflows || []).map((wf: any) => (
              <div key={wf.id} className="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs flex justify-between items-center">
                <div>
                  <span className="font-bold text-indigo-300 font-mono">{wf.workflow?.type || 'PreVisitQuestionnaire'}</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">Appt: {wf.appointmentId?.slice(0, 8)} • Attempts: {wf.attemptCount}</p>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  wf.status === 'Completed' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                }`}>
                  {wf.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Staff */}
      {activeTab === 'staff' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Staff & Access Management</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Email</th>
                  <th className="p-3">Role</th>
                  <th className="p-3">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.staff || []).map((u: any) => (
                  <tr key={u.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-semibold text-white">{u.name}</td>
                    <td className="p-3 text-slate-300">{u.email}</td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-500/20 text-teal-300">
                        {u.role}
                      </span>
                    </td>
                    <td className="p-3 text-slate-500">{new Date(u.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
