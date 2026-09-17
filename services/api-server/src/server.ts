import { buildApp } from './app.js';

async function main() {
  const app = await buildApp();
  const port = Number(process.env.API_PORT || 3001);

  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 API Server running at http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
