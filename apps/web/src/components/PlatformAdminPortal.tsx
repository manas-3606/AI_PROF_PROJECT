import React, { useState, useEffect } from 'react';
import { ApiService } from '../services/api.js';
import { Hospital, AuditEvent, OperationalEvent, ReconciliationRecord, CapabilityExecution } from '../types.js';
import {
  Shield, Server, CheckCircle2, AlertTriangle, Activity, RefreshCw, Zap, Building,
  Users, Calendar, FileText, Bot, GitCommit, GitBranch, Bell, Eye, Search, Layers, Clock, Cpu
} from 'lucide-react';
import { ChaosModal } from './ChaosModal.js';

export const PlatformAdminPortal: React.FC = () => {
  const [activeTab, setActiveTab] = useState<
    'overview' | 'applications' | 'hospitals' | 'doctors' | 'patients' | 'appointments' |
    'aiActivity' | 'integrations' | 'workflows' | 'analytics' | 'audit' | 'trace'
  >('overview');

  const [dashboardData, setDashboardData] = useState<any>(null);
  const [section19Metrics, setSection19Metrics] = useState<any>(null);
  const [isChaosOpen, setIsChaosOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Trace View state
  const [traceCorrelationId, setTraceCorrelationId] = useState('');
  const [traceResult, setTraceResult] = useState<any>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const [dash, s19] = await Promise.all([
        ApiService.getPlatformAdminDashboard(),
        ApiService.getSection19Metrics(),
      ]);
      setDashboardData(dash);
      setSection19Metrics(s19);

      // Default trace ID to most recent audit event or capability execution if available
      if (!traceCorrelationId) {
        const recentCorr =
          dash?.aiActivity?.[0]?.correlationId ||
          dash?.auditEvents?.[0]?.correlationId;
        if (recentCorr) {
          setTraceCorrelationId(recentCorr);
        }
      }
    } catch (e) {
      console.error('Failed to load platform admin dashboard:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleApproveHospital = async (id: string) => {
    try {
      await ApiService.updateHospitalStatus(id, 'APPROVED');
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleFetchTrace = async (corrId?: string) => {
    const target = corrId || traceCorrelationId;
    if (!target) return;
    try {
      setTraceLoading(true);
      setTraceError(null);
      const res = await ApiService.getTrace(target);
      setTraceResult(res);
    } catch (e: any) {
      setTraceError(e.message || 'Failed to fetch trace');
    } finally {
      setTraceLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Platform Admin Banner */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-indigo-600/20">
            <Shield className="w-7 h-7" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-xl font-bold text-white">Platform Administration & Governance</h2>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                PLATFORM_ADMIN
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              PRD Section 18 Global Administration • Section 19 Observability & End-to-End Traces
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setIsChaosOpen(true)}
            className="flex items-center space-x-1.5 px-3.5 py-2 bg-gradient-to-r from-amber-600 to-rose-600 hover:from-amber-500 hover:to-rose-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-amber-500/20 transition"
          >
            <Zap className="w-4 h-4" />
            <span>Chaos Simulator</span>
          </button>

          <button
            onClick={loadData}
            className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-xl border border-slate-800 transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Global Tab Navigation */}
      <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-900/90 rounded-2xl border border-slate-800 text-xs">
        {[
          { id: 'overview', label: 'Overview', icon: Server },
          { id: 'applications', label: 'Applications', icon: Building, badge: dashboardData?.applications?.length },
          { id: 'hospitals', label: 'Hospitals', icon: Building },
          { id: 'doctors', label: 'Doctors', icon: Users },
          { id: 'patients', label: 'Patients', icon: Users },
          { id: 'appointments', label: 'Appointments', icon: Calendar },
          { id: 'aiActivity', label: 'AI Activity', icon: Bot },
          { id: 'integrations', label: 'EHR Activity', icon: GitBranch },
          { id: 'workflows', label: 'Workflows', icon: Layers },
          { id: 'analytics', label: 'Section 19 Metrics', icon: Activity },
          { id: 'audit', label: 'Audit Logs', icon: FileText },
          { id: 'trace', label: 'Trace View (Correlation ID)', icon: GitCommit, highlight: true },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id as any);
                if (tab.id === 'trace' && traceCorrelationId && !traceResult) {
                  handleFetchTrace(traceCorrelationId);
                }
              }}
              className={`flex items-center space-x-1.5 px-3 py-2 rounded-xl font-medium transition ${
                isActive
                  ? tab.highlight
                    ? 'bg-gradient-to-r from-cyan-600 to-teal-600 text-white shadow-md'
                    : 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : tab.highlight
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
              {typeof tab.badge === 'number' && tab.badge > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500/30 text-amber-300 font-bold ml-1">
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
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Total Hospitals</span>
              <span className="text-2xl font-bold text-white">{dashboardData?.hospitals?.length || 0}</span>
              <span className="text-[11px] text-emerald-400 block mt-1">Multi-tenant isolated</span>
            </div>
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Active Doctors</span>
              <span className="text-2xl font-bold text-white">{dashboardData?.doctors?.length || 0}</span>
              <span className="text-[11px] text-teal-400 block mt-1">Across all approved facilities</span>
            </div>
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Total Bookings</span>
              <span className="text-2xl font-bold text-white">{dashboardData?.appointments?.length || 0}</span>
              <span className="text-[11px] text-cyan-400 block mt-1">100% verified with EHR</span>
            </div>
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Operational Health</span>
              <div className="flex items-center space-x-2 mt-1">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-base font-bold text-emerald-400">All Systems Nominal</span>
              </div>
              <span className="text-[11px] text-slate-400 block mt-1">API, Gateway, EHR connected</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Quick Trace Launcher */}
            <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
              <h3 className="text-base font-semibold text-white flex items-center space-x-2">
                <GitCommit className="w-4 h-4 text-cyan-400" />
                <span>PRD Section 19 Observability Trace View</span>
              </h3>
              <p className="text-xs text-slate-400">
                Inspect any end-to-end booking chain from natural language utterance through scheduling, EHR verification, and notification.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter Correlation ID (e.g. fc83b7ee-...)"
                  value={traceCorrelationId}
                  onChange={(e) => setTraceCorrelationId(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:border-cyan-500"
                />
                <button
                  onClick={() => {
                    setActiveTab('trace');
                    handleFetchTrace(traceCorrelationId);
                  }}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-semibold transition flex items-center space-x-1"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Inspect Trace</span>
                </button>
              </div>

              <div className="pt-2">
                <span className="text-[11px] text-slate-500 block mb-1.5 font-medium">Recent Correlation IDs:</span>
                <div className="flex flex-wrap gap-1.5">
                  {(dashboardData?.aiActivity || []).slice(0, 4).map((a: any, i: number) => (
                    <button
                      key={i}
                      onClick={() => {
                        setTraceCorrelationId(a.correlationId);
                        setActiveTab('trace');
                        handleFetchTrace(a.correlationId);
                      }}
                      className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-mono border border-slate-700 transition"
                    >
                      {a.capabilityName}: {a.correlationId?.slice(0, 10)}...
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Reconciliation Alerts */}
            <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
              <h3 className="text-base font-semibold text-white flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span>Reconciliation Desk</span>
              </h3>
              {(dashboardData?.reconciliations || []).length === 0 ? (
                <div className="p-6 bg-slate-900/50 rounded-xl border border-slate-800 text-xs text-slate-400 text-center">
                  <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-2" />
                  No open reconciliation records. All EHR transactions verified without discrepancy.
                </div>
              ) : (
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {dashboardData.reconciliations.map((r: any) => (
                    <div key={r.id} className="p-3 bg-amber-950/20 border border-amber-500/30 rounded-xl text-xs">
                      <div className="flex justify-between font-semibold text-amber-300">
                        <span>{r.reason}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20">{r.status}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1 font-mono">
                        Appt: {r.appointmentId?.slice(0, 8)} • Attempts: {r.attemptCount}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Applications */}
      {activeTab === 'applications' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Hospital Onboarding Applications</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Hospital Name</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">City</th>
                  <th className="p-3">Contact</th>
                  <th className="p-3">Submitted</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.applications || []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-slate-500">No pending hospital applications.</td>
                  </tr>
                ) : (
                  dashboardData.applications.map((h: any) => (
                    <tr key={h.id} className="hover:bg-slate-900/50">
                      <td className="p-3 font-semibold text-white">{h.name}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300">
                          {h.status}
                        </span>
                      </td>
                      <td className="p-3 text-slate-300">{h.city}</td>
                      <td className="p-3 text-slate-400">{h.contactEmail}</td>
                      <td className="p-3 text-slate-400">{new Date(h.createdAt).toLocaleDateString()}</td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => handleApproveHospital(h.id)}
                          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold"
                        >
                          Approve Application
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Hospitals */}
      {activeTab === 'hospitals' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Approved Hospitals & Tenants</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Hospital</th>
                  <th className="p-3">Slug</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Address</th>
                  <th className="p-3">Operating Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.hospitals || []).map((h: any) => (
                  <tr key={h.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-semibold text-white">{h.name}</td>
                    <td className="p-3 font-mono text-cyan-400">{h.slug}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        h.status === 'APPROVED' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                      }`}>
                        {h.status}
                      </span>
                    </td>
                    <td className="p-3 text-slate-300">{h.address}, {h.city}</td>
                    <td className="p-3 text-slate-400">{h.operatingHours}</td>
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
          <h3 className="text-base font-semibold text-white">Platform Doctors</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Specialty</th>
                  <th className="p-3">Hospital</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Slot Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.doctors || []).map((d: any) => (
                  <tr key={d.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-semibold text-white">{d.name}</td>
                    <td className="p-3 text-teal-400">{d.specialty}</td>
                    <td className="p-3 text-slate-300">{d.hospital?.name}</td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
                        {d.status}
                      </span>
                    </td>
                    <td className="p-3 text-slate-400">{d.appointmentDurationMinutes} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Patients */}
      {activeTab === 'patients' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Registered Patients</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Email (Masked)</th>
                  <th className="p-3">Phone (Masked)</th>
                  <th className="p-3">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.patients || []).map((p: any) => (
                  <tr key={p.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-semibold text-white">{p.name}</td>
                    <td className="p-3 font-mono text-slate-400">{p.email ? `${p.email.slice(0, 2)}***@***` : 'N/A'}</td>
                    <td className="p-3 font-mono text-slate-400">{p.phone ? `***-***-${p.phone.slice(-4)}` : 'N/A'}</td>
                    <td className="p-3 text-slate-500">{new Date(p.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Appointments */}
      {activeTab === 'appointments' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Platform-Wide Appointments</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Patient</th>
                  <th className="p-3">Doctor</th>
                  <th className="p-3">Hospital</th>
                  <th className="p-3">Time</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.appointments || []).map((a: any) => (
                  <tr key={a.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-medium text-white">{a.patient?.name}</td>
                    <td className="p-3 text-teal-400">{a.doctor?.name}</td>
                    <td className="p-3 text-slate-300">{a.hospital?.name}</td>
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

      {/* Tab: AI Activity */}
      {activeTab === 'aiActivity' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Controlled Capability Executions</h3>
          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {(dashboardData?.aiActivity || []).map((c: any) => (
              <div key={c.id} className="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs flex justify-between items-center">
                <div>
                  <span className="font-bold text-teal-300 font-mono">{c.capabilityName}</span>
                  <p className="text-[10px] text-slate-400 font-mono mt-0.5">Correlation: {c.correlationId}</p>
                </div>
                <div className="text-right">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    c.status === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                  }`}>
                    {c.status} ({c.durationMs}ms)
                  </span>
                  <span className="block text-[10px] text-slate-500 mt-1">{new Date(c.createdAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: EHR & Integration Activity */}
      {activeTab === 'integrations' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">EHR Integration Operations & Verifications</h3>
          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {(dashboardData?.integrationActivity || []).map((op: any) => (
              <div key={op.id} className="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs flex justify-between items-center">
                <div>
                  <span className="font-bold text-cyan-300 font-mono">{op.eventType}</span>
                  <p className="text-[11px] text-slate-300 mt-0.5">{op.message}</p>
                  <p className="text-[10px] text-slate-500 font-mono">Correlation: {op.correlationId || 'N/A'}</p>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">{new Date(op.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Workflows */}
      {activeTab === 'workflows' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Async Workflow Executions</h3>
          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {(dashboardData?.workflows || []).map((wf: any) => (
              <div key={wf.id} className="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs flex justify-between items-center">
                <div>
                  <span className="font-bold text-indigo-300 font-mono">{wf.workflow?.type || 'PreVisitQuestionnaire'}</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">Attempt: {wf.attemptCount} • Appt: {wf.appointmentId?.slice(0, 8) || 'N/A'}</p>
                </div>
                <div className="text-right">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    wf.status === 'Completed' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                  }`}>
                    {wf.status}
                  </span>
                  <span className="block text-[10px] text-slate-500 mt-1">{new Date(wf.scheduledAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Section 19 Metrics */}
      {activeTab === 'analytics' && (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-white">PRD Section 19 Standard Metrics</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">AI Conversations</span>
              <span className="text-2xl font-bold text-white">{section19Metrics?.ai?.totalConversations || 0}</span>
              <span className="text-[11px] text-teal-400 block mt-1">
                {section19Metrics?.ai?.clinicalSafetyTriggers || 0} safety triggers handled
              </span>
            </div>
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Slot Utilization</span>
              <span className="text-2xl font-bold text-white">{section19Metrics?.scheduling?.utilizationRatePercent || 0}%</span>
              <span className="text-[11px] text-cyan-400 block mt-1">
                {section19Metrics?.scheduling?.bookedSlots || 0} / {section19Metrics?.scheduling?.totalSlots || 0} slots
              </span>
            </div>
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">EHR Operations Verified</span>
              <span className="text-2xl font-bold text-white">{section19Metrics?.integration?.verifiedCount || 0}</span>
              <span className="text-[11px] text-emerald-400 block mt-1">
                Avg Latency: {section19Metrics?.integration?.averageVerificationLatencyMs || 0}ms
              </span>
            </div>
            <div className="glass-card p-5 rounded-xl border border-slate-800">
              <span className="text-xs text-slate-400 font-medium block mb-1">Workflows Completed</span>
              <span className="text-2xl font-bold text-white">{section19Metrics?.workflow?.completedWorkflows || 0}</span>
              <span className="text-[11px] text-indigo-400 block mt-1">
                {section19Metrics?.workflow?.totalNotificationsDispatched || 0} notifications sent
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Audit Logs */}
      {activeTab === 'audit' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="text-base font-semibold text-white">Immutable Audit Events</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="p-3">Action</th>
                  <th className="p-3">Actor Role</th>
                  <th className="p-3">Correlation ID</th>
                  <th className="p-3">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(dashboardData?.auditEvents || []).map((e: any) => (
                  <tr key={e.id} className="hover:bg-slate-900/50">
                    <td className="p-3 font-mono font-semibold text-indigo-300">{e.action}</td>
                    <td className="p-3 text-slate-300">{e.actorRole || 'SYSTEM'}</td>
                    <td className="p-3 font-mono text-cyan-400">{e.correlationId}</td>
                    <td className="p-3 text-slate-400">{new Date(e.timestamp).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Trace View */}
      {activeTab === 'trace' && (
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h3 className="text-base font-semibold text-white flex items-center space-x-2">
                <GitCommit className="w-5 h-5 text-cyan-400" />
                <span>End-to-End Correlation Trace View (PRD Section 19)</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Full 9-stage sequence: Conversation → AI Decision → Capability → Scheduling → EHR Operation → Verification → Synchronization → Workflow → Notification
              </p>
            </div>
            <div className="flex gap-2 w-full sm:w-auto">
              <input
                type="text"
                placeholder="Correlation ID"
                value={traceCorrelationId}
                onChange={(e) => setTraceCorrelationId(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-white font-mono placeholder-slate-500 flex-1 sm:w-64"
              />
              <button
                onClick={() => handleFetchTrace()}
                className="px-3.5 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-semibold"
              >
                Inspect
              </button>
            </div>
          </div>

          {traceLoading && <p className="text-xs text-cyan-400">Loading trace events...</p>}
          {traceError && <p className="text-xs text-rose-400">Error: {traceError}</p>}

          {traceResult && (
            <div className="space-y-4">
              <div className="p-4 bg-slate-900 rounded-xl border border-slate-800 text-xs flex justify-between items-center">
                <span className="font-mono text-cyan-300">Correlation ID: {traceResult.correlationId}</span>
                <span className="text-slate-400">
                  Duration: {new Date(traceResult.endTime).getTime() - new Date(traceResult.startTime).getTime()}ms
                </span>
              </div>

              {/* 9-Stage Visual Timeline */}
              <div className="space-y-3 relative before:absolute before:inset-0 before:left-4 before:w-0.5 before:bg-slate-800">
                {traceResult.stages.map((st: any) => (
                  <div key={st.stageNumber} className="relative flex items-start space-x-4 pl-2">
                    <div className="w-5 h-5 rounded-full bg-cyan-500/20 border border-cyan-400 flex items-center justify-center text-[10px] font-bold text-cyan-300 z-10">
                      {st.stageNumber}
                    </div>
                    <div className="flex-1 p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-white text-sm">{st.stageName}</span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
                          {st.status}
                        </span>
                      </div>
                      <p className="text-slate-300 mt-1">{st.description}</p>
                      <pre className="mt-2 p-2 bg-slate-950 rounded border border-slate-800 text-[10px] font-mono text-slate-400 overflow-x-auto">
                        {JSON.stringify(st.details, null, 2)}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <ChaosModal isOpen={isChaosOpen} onClose={() => setIsChaosOpen(false)} />
    </div>
  );
};
