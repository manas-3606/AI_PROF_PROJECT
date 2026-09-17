const API_BASE = 'http://localhost:3001/api';

export class ApiService {
  private static token: string | null = null;

  static setToken(token: string | null) {
    this.token = token;
  }

  private static getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  static async login(email: string, password: string = 'password123') {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error('Login failed');
    const data = await res.json();
    this.setToken(data.token);
    return data;
  }

  static async getHospitals(status?: string) {
    const query = status ? `?status=${status}` : '';
    const res = await fetch(`${API_BASE}/hospitals${query}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async updateHospitalStatus(id: string, status: string) {
    const res = await fetch(`${API_BASE}/hospitals/${id}/status`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify({ status }),
    });
    return await res.json();
  }

  static async getDoctors(hospitalId?: string, specialty?: string) {
    const params = new URLSearchParams();
    if (hospitalId) params.append('hospitalId', hospitalId);
    if (specialty) params.append('specialty', specialty);
    const res = await fetch(`${API_BASE}/doctors?${params}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getDoctorSlots(doctorId: string) {
    const res = await fetch(`${API_BASE}/doctors/${doctorId}/slots`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.slots || [];
  }

  static async getAppointments(params: { patientId?: string; doctorId?: string; hospitalId?: string }) {
    const search = new URLSearchParams();
    if (params.patientId) search.append('patientId', params.patientId);
    if (params.doctorId) search.append('doctorId', params.doctorId);
    if (params.hospitalId) search.append('hospitalId', params.hospitalId);

    const res = await fetch(`${API_BASE}/appointments?${search}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async createAppointment(payload: any) {
    const res = await fetch(`${API_BASE}/appointments`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create appointment');
    }
    return await res.json();
  }

  static async rescheduleAppointment(appointmentId: string, newSlotId: string) {
    const res = await fetch(`${API_BASE}/appointments/${appointmentId}/reschedule`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ newSlotId }),
    });
    return await res.json();
  }

  static async cancelAppointment(appointmentId: string, reason?: string) {
    const res = await fetch(`${API_BASE}/appointments/${appointmentId}/cancel`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ reason }),
    });
    return await res.json();
  }

  static async synchronizeAppointment(appointmentId: string) {
    const res = await fetch(`${API_BASE}/appointments/${appointmentId}/synchronize`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  static async getQuestionnaires(hospitalId?: string) {
    const query = hospitalId ? `?hospitalId=${hospitalId}` : '';
    const res = await fetch(`${API_BASE}/questionnaires${query}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async submitQuestionnaire(payload: {
    questionnaireId: string;
    appointmentId: string;
    patientId: string;
    responses: Record<string, any>;
  }) {
    const res = await fetch(`${API_BASE}/questionnaires/submit`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  static async executeCapability(name: string, input: any, conversationId?: string) {
    const res = await fetch(`${API_BASE}/capabilities/execute`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ name, input, conversationId }),
    });
    return await res.json();
  }

  static async getMetrics() {
    const res = await fetch(`${API_BASE}/analytics/metrics`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getAuditLogs(limit: number = 50, tenantId?: string) {
    const search = new URLSearchParams({ limit: String(limit) });
    if (tenantId) search.append('tenantId', tenantId);
    const res = await fetch(`${API_BASE}/analytics/audit-logs?${search}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getChaosStatus() {
    const res = await fetch(`${API_BASE}/chaos/status`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async configureChaos(body: { simulatedLatencyMs?: number; failureMode?: string }) {
    const res = await fetch(`${API_BASE}/chaos/configure`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    return await res.json();
  }

  static async resetChaos() {
    const res = await fetch(`${API_BASE}/chaos/reset`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  static async getTrace(correlationId: string) {
    const res = await fetch(`${API_BASE}/analytics/trace/${encodeURIComponent(correlationId)}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getSection19Metrics() {
    const res = await fetch(`${API_BASE}/analytics/section-19-metrics`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getPlatformAdminDashboard() {
    const res = await fetch(`${API_BASE}/analytics/dashboard/platform-admin`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getHospitalAdminDashboard(hospitalId?: string) {
    const query = hospitalId ? `?hospitalId=${encodeURIComponent(hospitalId)}` : '';
    const res = await fetch(`${API_BASE}/analytics/dashboard/hospital-admin${query}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getDoctorDashboard(doctorId?: string) {
    const query = doctorId ? `?doctorId=${encodeURIComponent(doctorId)}` : '';
    const res = await fetch(`${API_BASE}/analytics/dashboard/doctor${query}`, { headers: this.getHeaders() });
    return await res.json();
  }

  static async getPatientDashboard(patientId?: string) {
    const query = patientId ? `?patientId=${encodeURIComponent(patientId)}` : '';
    const res = await fetch(`${API_BASE}/analytics/dashboard/patient${query}`, { headers: this.getHeaders() });
    return await res.json();
  }
}

