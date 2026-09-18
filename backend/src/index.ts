import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb, syncIndexes } from './db/connect.js';
import { loadClinicalContent } from './content/loader.js';
import { printSeedResult, runSeed } from './scripts/seedCore.js';

async function main(): Promise<void> {
  const config = env();

  // Fail fast if the clinical content is malformed: a broken ruleset must never
  // reach a running server.
  const content = loadClinicalContent();

  const uri = await connectDb(config);
  await syncIndexes();

  // The in-memory database starts empty every time, so the demo would have no
  // accounts to log in with unless the server seeds itself here.
  if (config.useInMemoryDb) {
    printSeedResult(await runSeed());
  }

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(
      JSON.stringify({
        message: 'TwinRx backend ishga tushdi',
        port: config.PORT,
        app_env: config.APP_ENV,
        db: config.useInMemoryDb ? 'in-memory (ma’lumot saqlanmaydi)' : maskUri(uri),
        ruleset_version: content.rulesetVersion,
        reviewed_rules: content.rules.filter((r) => r.review_status === 'reviewed' && r.enabled).length,
        llm_provider: config.LLM_PROVIDER,
      }),
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} qabul qilindi, to‘xtatilmoqda…`);
    server.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Never print credentials that may be embedded in a connection string. */
function maskUri(uri: string): string {
  return uri.replace(/\/\/[^@]*@/, '//***@');
}

main().catch((err) => {
  console.error('Ishga tushirishda xato:', err instanceof Error ? err.message : err);
  process.exit(1);
});
