import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const turns = await prisma.capabilityExecution.findMany({
    where: {
      correlationId: {
        in: ['turn-1789846607503', 'turn-1789846634988', 'turn-1789846662692']
      }
    }
  });
  console.log('Turn capability executions:');
  for (const t of turns) {
    console.log(JSON.stringify(t, null, 2));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
