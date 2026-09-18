import mongoose from 'mongoose';
import type { Env } from '../config/env.js';

type MemoryServer = { getUri(): string; stop(): Promise<boolean> };

let memoryServer: MemoryServer | null = null;

/**
 * Connect to MongoDB. When USE_IN_MEMORY_DB is on (the default for a laptop
 * demo with neither Docker nor a local mongod), an in-process MongoDB is
 * started instead. That mode keeps no data across restarts — the README says
 * so, and the "Qayta ishga tushirish" NFR is only claimed for a real server.
 */
export async function connectDb(config: Env): Promise<string> {
  mongoose.set('strictQuery', true);

  let uri = config.MONGODB_URI;
  if (config.useInMemoryDb) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create({ instance: { dbName: 'twinrx' } });
    uri = memoryServer.getUri();
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  await mongoose.connection.asPromise();
  return uri;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.connection.close();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function syncIndexes(): Promise<void> {
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}
