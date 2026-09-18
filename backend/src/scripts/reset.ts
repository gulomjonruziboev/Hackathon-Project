import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectDb, disconnectDb, syncIndexes } from '../db/connect.js';
import { printSeedResult, runSeed } from './seedCore.js';

/**
 * Spec 13: demo reset exists only as a CLI command and only when APP_ENV=demo.
 * There is deliberately no HTTP endpoint for it.
 */
async function main(): Promise<void> {
  const config = env();
  if (config.APP_ENV !== 'demo') {
    throw new Error(`Reset faqat APP_ENV=demo da ishlaydi (joriy: ${config.APP_ENV}).`);
  }
  if (config.useInMemoryDb) {
    throw new Error('In-memory rejimda reset kerak emas: serverni qayta ishga tushiring.');
  }

  await connectDb(config);
  await syncIndexes();

  const collections = await mongoose.connection.db!.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
  console.log(`${collections.length} ta kolleksiya tozalandi.`);

  printSeedResult(await runSeed());
  await disconnectDb();
}

main().catch(async (err) => {
  console.error('Reset xatosi:', err instanceof Error ? err.message : err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
