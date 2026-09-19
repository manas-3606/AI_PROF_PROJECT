async function checkService(name, url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    return { name, url, reachable: true, status: res.status };
  } catch (err) {
    clearTimeout(t);
    return { name, url, reachable: false, error: err.name === 'AbortError' ? 'TIMEOUT (6s)' : err.message };
  }
}

async function main() {
  const services = [
    { name: 'api-server (Fastify HTTP)', url: 'https://ai-prof-project-1.onrender.com/health' },
    { name: 'web (React SPA UI)', url: 'https://ai-prof-project-1.onrender.com/' },
    { name: 'voice-gateway (Configured WS/WSS URL)', url: 'https://ai-prof-voice-gateway.onrender.com/health' },
    { name: 'mock-ehr (Configured Mock EHR URL)', url: 'https://ai-prof-mock-ehr.onrender.com/health' },
  ];

  const results = await Promise.all(services.map(s => checkService(s.name, s.url)));
  console.log('--- Reachability of all 4 configured service endpoints ---');
  console.log(JSON.stringify(results, null, 2));
}

main();
