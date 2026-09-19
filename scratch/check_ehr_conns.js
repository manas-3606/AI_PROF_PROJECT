const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const conns = await prisma.healthcareSystemConnection.findMany();
  console.log('EHR Connections in DB:');
  for (const c of conns) {
    console.log(c.id, 'Hospital:', c.hospitalId, 'Type:', c.systemType, 'BaseUrl:', c.baseUrl, 'Status:', c.status);
  }
}

check().then(() => prisma.$disconnect()).catch(err => {
  console.error(err);
  prisma.$disconnect();
});
