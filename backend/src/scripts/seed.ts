import { env } from '../config/env.js';
import { connectDb, disconnectDb, syncIndexes } from '../db/connect.js';
import { printSeedResult, runSeed } from './seedCore.js';

async function main(): Promise<void> {
  const config = env();
  if (config.useInMemoryDb) {
    // An in-process MongoDB dies with this script, so seeding it separately
    // would achieve nothing. In that mode the server seeds itself on boot.
    console.error(
      'Bu rejimda baza in-memory ishlaydi va alohida seed saqlanmaydi.\n' +
        'MONGODB_URI ni bering yoki `npm run dev` ni ishga tushiring — server o‘zini avtomatik seed qiladi.',
    );
    process.exit(1);
  }

  await connectDb(config);
  await syncIndexes();
  printSeedResult(await runSeed());
  await disconnectDb();
}

main().catch(async (err) => {
  console.error('Seed xatosi:', err instanceof Error ? err.message : err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
