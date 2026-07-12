import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// BigInt serialization fix: standard JSON.stringify() does not support BigInt values.
// Patching BigInt.prototype.toJSON allows objects with BigInt fields (such as Repository/PullRequest githubId)
// to be serialized safely in API responses.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const prismaClientSingleton = () => {
  // 1. Initialize a connection pool using the standard pg driver
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString });
  
  // 2. Wrap the pool in the Prisma pg adapter
  const adapter = new PrismaPg(pool);
  
  // 3. Pass the adapter to the Prisma Client constructor
  return new PrismaClient({ adapter });
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma;