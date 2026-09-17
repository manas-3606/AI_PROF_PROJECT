import { prisma } from '@health/db';

export class IdentifierMapper {
  static async getExternalId(
    hospitalIdOrTenantId: string,
    entityType: 'PATIENT' | 'DOCTOR' | 'APPOINTMENT' | 'FACILITY',
    internalId: string
  ): Promise<string | null> {
    const hospitalId = hospitalIdOrTenantId;
    const mapping = await prisma.externalIdentifierMapping.findUnique({
      where: {
        hospitalId_entityType_internalId: {
          hospitalId,
          entityType,
          internalId,
        },
      },
    });
    return mapping?.externalId || null;
  }

  static async setMapping(
    hospitalIdOrTenantId: string,
    entityType: 'PATIENT' | 'DOCTOR' | 'APPOINTMENT' | 'FACILITY',
    internalId: string,
    externalId: string
  ): Promise<void> {
    const hospitalId = hospitalIdOrTenantId;
    const existingByInternal = await prisma.externalIdentifierMapping.findUnique({
      where: { hospitalId_entityType_internalId: { hospitalId, entityType, internalId } },
    });

    if (existingByInternal) {
      await prisma.externalIdentifierMapping.update({
        where: { id: existingByInternal.id },
        data: { externalId, tenantId: hospitalId },
      });
      return;
    }

    const existingByExternal = await prisma.externalIdentifierMapping.findUnique({
      where: { hospitalId_entityType_externalId: { hospitalId, entityType, externalId } },
    });

    if (existingByExternal) {
      await prisma.externalIdentifierMapping.update({
        where: { id: existingByExternal.id },
        data: { internalId, tenantId: hospitalId },
      });
      return;
    }

    await prisma.externalIdentifierMapping.create({
      data: {
        hospitalId,
        tenantId: hospitalId,
        entityType,
        internalId,
        externalId,
      },
    });
  }

  static async getInternalId(
    hospitalIdOrTenantId: string,
    entityType: 'PATIENT' | 'DOCTOR' | 'APPOINTMENT' | 'FACILITY',
    externalId: string
  ): Promise<string | null> {
    const hospitalId = hospitalIdOrTenantId;
    const mapping = await prisma.externalIdentifierMapping.findUnique({
      where: {
        hospitalId_entityType_externalId: {
          hospitalId,
          entityType,
          externalId,
        },
      },
    });
    return mapping?.internalId || null;
  }
}
