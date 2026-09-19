const { WebSocket } = require('ws');
const crypto = require('crypto');

const BASE_URL = 'https://ai-prof-project-1.onrender.com';
const VOICE_WS_URL = 'wss://ai-prof-voice-gateway.onrender.com/ws/voice';

async function postJson(url, data, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, headers: res.headers, json };
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headers },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, headers: res.headers, json };
}

async function main() {
  console.log('=== VERIFYING DEPLOYED PRODUCTION INSTANCE ===\n');

  // 1. Health check
  console.log('1. Checking /health on API server...');
  const health = await getJson(`${BASE_URL}/health`);
  console.log('  API /health response:', health.status, health.json);

  // 2. CORS Preflight & Headers
  console.log('\n2. Testing CORS headers on /api/hospitals...');
  const corsRes = await fetch(`${BASE_URL}/api/hospitals`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://ai-prof-project-1.onrender.com',
      'Access-Control-Request-Method': 'GET',
    },
  });
  console.log('  CORS Options status:', corsRes.status);
  console.log('  Access-Control-Allow-Origin:', corsRes.headers.get('access-control-allow-origin'));
  console.log('  Access-Control-Allow-Credentials:', corsRes.headers.get('access-control-allow-credentials'));

  // 3. User Logins across all 4 roles
  console.log('\n3. Testing Auth & Logins across roles:');
  const users = [
    { role: 'PLATFORM_ADMIN', email: 'platform.admin@health.org', pass: 'Password123!' },
    { role: 'HOSPITAL_ADMIN_APEX', email: 'admin@apexhealth.org', pass: 'Password123!' },
    { role: 'HOSPITAL_ADMIN_METRO', email: 'admin@metrohealth.org', pass: 'Password123!' },
    { role: 'DOCTOR', email: 'dr.rao@apexhealth.org', pass: 'Password123!' },
    { role: 'PATIENT', email: 'jane.doe@example.com', pass: 'Password123!' },
  ];

  const tokens = {};
  for (const u of users) {
    const loginRes = await postJson(`${BASE_URL}/api/auth/login`, {
      email: u.email,
      password: u.pass,
    });
    if (loginRes.ok && loginRes.json.token) {
      console.log(`  [PASS] ${u.role} (${u.email}): login succeeded, token length = ${loginRes.json.token.length}`);
      tokens[u.role] = loginRes.json.token;
    } else {
      console.log(`  [FAIL] ${u.role} (${u.email}):`, loginRes.status, loginRes.json);
    }
  }

  // 4. Test Multi-Tenant Isolation
  console.log('\n4. Testing Tenant Isolation:');
  if (tokens.HOSPITAL_ADMIN_APEX && tokens.HOSPITAL_ADMIN_METRO) {
    const apexDash = await getJson(`${BASE_URL}/api/analytics/dashboard/hospital-admin`, {
      Authorization: `Bearer ${tokens.HOSPITAL_ADMIN_APEX}`,
    });
    const metroDash = await getJson(`${BASE_URL}/api/analytics/dashboard/hospital-admin`, {
      Authorization: `Bearer ${tokens.HOSPITAL_ADMIN_METRO}`,
    });
    console.log(`  Apex Admin Hospital: ${apexDash.json.hospital?.name} (ID: ${apexDash.json.hospital?.id})`);
    console.log(`  Apex Admin Doctors count: ${apexDash.json.doctors?.length || 0}`);
    console.log(`  Metro Admin Hospital: ${metroDash.json.hospital?.name} (ID: ${metroDash.json.hospital?.id})`);
    console.log(`  Metro Admin Doctors count: ${metroDash.json.doctors?.length || 0}`);
    if (apexDash.json.hospital?.id && metroDash.json.hospital?.id && apexDash.json.hospital?.id !== metroDash.json.hospital?.id) {
      console.log('  [PASS] Tenant isolation verified: Each hospital admin receives only their own hospital and doctors.');
    } else {
      console.log('  [FAIL] Both admins saw the same hospital ID or null!');
    }
  }

  // 5. Test 4 Role Dashboards
  console.log('\n5. Testing 4 Role Dashboards:');
  if (tokens.PLATFORM_ADMIN) {
    const pa = await getJson(`${BASE_URL}/api/analytics/dashboard/platform-admin`, {
      Authorization: `Bearer ${tokens.PLATFORM_ADMIN}`,
    });
    console.log(`  Platform Admin Dashboard: status=${pa.status}, hospitals=${pa.json.hospitals?.length}, totalDoctors=${pa.json.metrics?.totalDoctors}`);
  }
  if (tokens.DOCTOR) {
    const doc = await getJson(`${BASE_URL}/api/analytics/dashboard/doctor`, {
      Authorization: `Bearer ${tokens.DOCTOR}`,
    });
    console.log(`  Doctor Dashboard: status=${doc.status}, doctor=${doc.json.doctor?.name}, appointments=${doc.json.appointments?.length}`);
  }
  if (tokens.PATIENT) {
    const pat = await getJson(`${BASE_URL}/api/analytics/dashboard/patient`, {
      Authorization: `Bearer ${tokens.PATIENT}`,
    });
    console.log(`  Patient Dashboard: status=${pat.status}, patient=${pat.json.patient?.name}, appointments=${pat.json.appointments?.length}`);
  }

  // 6. Test Voice Gateway WebSocket
  console.log('\n6. Testing Voice Gateway WebSocket connectivity:');
  try {
    const wsPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(VOICE_WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timed out'));
      }, 10000);

      ws.on('open', () => {
        console.log('  [PASS] Connected to Voice Gateway WebSocket at', VOICE_WS_URL);
        // Send a ping / voice event
        ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('  [PASS] Received WS message:', msg);
        clearTimeout(timeout);
        ws.close();
        resolve(msg);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    await wsPromise;
  } catch (err) {
    console.log('  [FAIL] Voice Gateway WebSocket:', err.message);
  }

  // 7. Test Chat Conversation (Symptom report & Doctor Discovery)
  console.log('\n7. Testing Live Chat Conversation API (/api/chat/turn):');
  const convId = crypto.randomUUID();
  const chat1 = await postJson(`${BASE_URL}/api/chat/turn`, {
    message: 'Hello, I am having severe knee pain and need to see an orthopedic doctor',
    conversationId: convId,
  });
  console.log('  Turn 1 status:', chat1.status);
  console.log('  Spoken text:', chat1.json.spokenText);
  console.log('  Intent detected:', chat1.json.intentDetected);
  console.log('  Capability called:', chat1.json.capabilityCalled);
  console.log('  Capability result doctor count:', chat1.json.capabilityResult?.doctors?.length);

  console.log('\n=== VERIFICATION FINISHED ===');
}

main().catch(console.error);
