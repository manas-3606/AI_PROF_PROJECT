async function testApiEndpoints() {
  const endpoints = [
    'http://localhost:3001/api/analytics/metrics',
    'http://localhost:3001/api/analytics/section-19-metrics',
    'http://localhost:3001/api/analytics/dashboard/platform-admin',
    'http://localhost:3001/api/analytics/dashboard/hospital-admin',
    'http://localhost:3001/api/analytics/dashboard/doctor',
    'http://localhost:3001/api/analytics/dashboard/patient',
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep);
      const json = await res.json();
      console.log(`\n=== ${ep} (Status: ${res.status}) ===`);
      if (ep.includes('section-19-metrics')) {
        console.log(JSON.stringify(json, null, 2));
      } else if (ep.includes('platform-admin')) {
        console.log({
          hospitals: json.hospitals?.length,
          doctors: json.doctors?.length,
          patients: json.patients?.length,
          appointments: json.appointments?.length,
          aiActivity: json.aiActivity?.length,
          integrationActivity: json.integrationActivity?.length,
          workflows: json.workflows?.length,
          reconciliations: json.reconciliations?.length,
        });
      } else if (ep.includes('hospital-admin')) {
        console.log({
          hospitalName: json.hospital?.name,
          doctors: json.doctors?.length,
          appointments: json.appointments?.length,
          workflows: json.workflows?.length,
          integrationEvents: json.integrationEvents?.length,
        });
      } else if (ep.includes('doctor')) {
        console.log({
          doctorName: json.doctor?.name,
          appointments: json.appointments?.length,
          preVisitResponses: json.preVisitResponses?.length,
        });
      } else if (ep.includes('patient')) {
        console.log({
          patientName: json.patient?.name,
          appointments: json.appointments?.length,
          upcoming: json.upcomingAppointments?.length,
          notifications: json.notifications?.length,
        });
      } else {
        console.log(json);
      }
    } catch (e: any) {
      console.error(`Error fetching ${ep}:`, e.message);
    }
  }
}

testApiEndpoints();
