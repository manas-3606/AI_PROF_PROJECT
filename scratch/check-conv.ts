import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const conv = await prisma.aiConversation.findUnique({
    where: { id: '6fb90212-b1eb-4431-8149-bf4f7ec29989' },
    include: { context: true }
  });
  console.log('Conv:', conv);
  if (conv?.context) {
    console.log('Context JSON:', conv.context.contextJson);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
