async function checkHealth() {
  console.log('=== CHECK 25: All 4 Services Clean Boot & Health Verification ===\n');

  const targets = [
    { name: 'api-server', url: 'http://localhost:3001/health', expectedStatus: 200 },
    { name: 'mock-ehr', url: 'http://localhost:4000/health', expectedStatus: 200 },
    { name: 'voice-gateway', url: 'http://localhost:3002/health', expectedStatus: 200 },
    { name: 'web', url: 'http://localhost:5173/', expectedStatus: 200 },
  ];

  let allPass = true;

  for (const t of targets) {
    try {
      const res = await fetch(t.url);
      const isJson = res.headers.get('content-type')?.includes('application/json');
      const body = isJson ? await res.json() : (await res.text()).slice(0, 100);
      const passed = res.status === t.expectedStatus;
      console.log(`Service [${t.name}]: HTTP ${res.status} (Expected: ${t.expectedStatus}) - ${passed ? 'HEALTHY ✅' : 'FAILED ❌'}`);
      console.log(`  URL: ${t.url}`);
      console.log(`  Response: ${JSON.stringify(body)}`);
      if (!passed) allPass = false;
    } catch (err: any) {
      console.log(`Service [${t.name}]: Connection error - ${err.message} ❌`);
      allPass = false;
    }
  }

  console.log(`\nAll 4 services cleanly booted and responding: ${allPass ? 'YES (PASS) ✅' : 'NO (FAIL) ❌'}`);
}

checkHealth();
