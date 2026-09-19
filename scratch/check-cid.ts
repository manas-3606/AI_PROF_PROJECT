import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const cid = '93d2d298-0ed0-478d-9099-7609baf5171c';
  const execs = await prisma.capabilityExecution.findMany({ where: { correlationId: cid } });
  const audits = await prisma.auditEvent.findMany({ where: { correlationId: cid } });
  const ops = await prisma.operationalEvent.findMany({ where: { correlationId: cid } });
  console.log('Execs:', execs);
  console.log('Audits:', audits);
  console.log('Ops:', ops);
}

main().catch(console.error).finally(() => prisma.$disconnect());
