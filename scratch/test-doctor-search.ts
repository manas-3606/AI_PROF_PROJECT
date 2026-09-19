import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const caseSensitive = await prisma.doctor.findMany({
    where: { name: { contains: 'arvind' } }
  });
  console.log('Case sensitive matches ("arvind"):', caseSensitive.length);

  const caseInsensitive = await prisma.doctor.findMany({
    where: { name: { contains: 'arvind', mode: 'insensitive' } }
  });
  console.log('Case insensitive matches ("arvind"):', caseInsensitive.map(d => ({ id: d.id, name: d.name })));

  const cleanQuery = "Arvind Rao".replace(/^(?:dr\.?|doctor)\s+/i, '').trim();
  const lastName = cleanQuery.split(/\s+/).pop();
  console.log({ cleanQuery, lastName });
  
  const matches = await prisma.doctor.findMany({
    where: {
      OR: [
        { name: { contains: cleanQuery, mode: 'insensitive' } },
        ...(lastName && lastName !== cleanQuery ? [{ name: { contains: lastName, mode: 'insensitive' } }] : [])
      ]
    }
  });
  console.log('Matches with mode insensitive:', matches.map(d => ({ id: d.id, name: d.name })));
}
main().catch(console.error).finally(() => prisma.$disconnect());
