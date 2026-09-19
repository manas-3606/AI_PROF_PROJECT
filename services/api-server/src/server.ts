import { buildApp } from './app.js';

async function main() {
  const app = await buildApp();
  const port = Number(process.env.API_PORT || 3001);

  const closeHandler = async (signal: string) => {
    console.log(`Received ${signal}, closing Fastify gracefully...`);
    try {
      await app.close();
    } catch (err) {
      console.error('Error closing Fastify app:', err);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => closeHandler('SIGTERM'));
  process.once('SIGINT', () => closeHandler('SIGINT'));

  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 API Server running at http://localhost:${port}`);
  } catch (err: any) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

