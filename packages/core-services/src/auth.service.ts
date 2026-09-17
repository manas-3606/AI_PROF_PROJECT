import { SignJWT, jwtVerify } from 'jose';
import { prisma } from '@health/db';
import { AuthUser, UserRole } from '@health/shared-types';
import bcrypt from 'bcrypt';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'super-secret-prototype-jwt-key-2026');

export class AuthService {
  /**
   * Signs a stateless JWT containing user identity and tenant claims.
   */
  static async signToken(user: AuthUser): Promise<string> {
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

  /**
   * Cryptographically verifies JWT and hydrates AuthUser.
   */
  static async verifyToken(token: string): Promise<AuthUser | null> {
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

  /**
   * Authenticates user credentials and issues a JWT token.
   */
  static async login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { doctor: true, patient: true },
    });

    if (!user) {
      throw new Error('Invalid email or password');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new Error('Invalid email or password');
    }

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
      tenantId: user.hospitalId || undefined,
      patientId: user.patient?.id,
      doctorId: user.doctor?.id,
    };

    const token = await this.signToken(authUser);
    return { token, user: authUser };
  }

  /**
   * Registers a self-service patient user.
   */
  static async registerPatient(data: {
    name: string;
    email: string;
    password: string;
    phone: string;
    dateOfBirth?: string;
  }): Promise<{ token: string; user: AuthUser }> {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new Error(`Email "${data.email}" is already registered`);
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        name: data.name,
        role: UserRole.PATIENT,
      },
    });

    const patient = await prisma.patient.create({
      data: {
        userId: user.id,
        name: data.name,
        email: data.email,
        phone: data.phone,
        dateOfBirth: data.dateOfBirth,
        communicationPreference: 'sms',
      },
    });

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: UserRole.PATIENT,
      patientId: patient.id,
    };

    const token = await this.signToken(authUser);
    return { token, user: authUser };
  }
}
