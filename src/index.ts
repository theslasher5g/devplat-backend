import { config } from './config.js';
import { migrate } from './migrate.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  await migrate();
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
