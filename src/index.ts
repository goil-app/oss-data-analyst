import 'dotenv/config';
import { startBot } from './lib/discord-client';
import { getSandboxManager } from './lib/sandbox';

startBot()
  .then(() => {
    console.log('Bot started successfully');
  })
  .catch((error) => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });

process.on('SIGTERM', async () => {
  console.log('[Process] SIGTERM received, shutting down...');
  await getSandboxManager().shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Process] SIGINT received, shutting down...');
  await getSandboxManager().shutdown();
  process.exit(0);
});
