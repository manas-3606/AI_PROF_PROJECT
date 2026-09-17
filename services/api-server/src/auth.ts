import { SignJWT, jwtVerify } from 'jose';
import { AuthUser, UserRole } from '@health/shared-types';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'super-secret-prototype-jwt-key-2026');

export async function signToken(user: AuthUser): Promise<string> {
  return await new SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    patientId: user.patientId,
    doctorId: user.doctorId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return {
      id: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as UserRole,
      tenantId: payload.tenantId as string | undefined,
      patientId: payload.patientId as string | undefined,
      doctorId: payload.doctorId as string | undefined,
    };
  } catch {
    return null;
  }
}
