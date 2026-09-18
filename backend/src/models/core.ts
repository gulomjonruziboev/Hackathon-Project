import { Schema, model } from 'mongoose';
import { baseOptions, uuidId, type BaseFields } from './base.js';

export type Role = 'doctor' | 'admin';

export type Clinic = BaseFields & { name: string };

export type User = BaseFields & {
  clinic_id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
  active: boolean;
};

export type Session = BaseFields & {
  user_id: string;
  clinic_id: string;
  role: Role;
  token_hash: string;
  csrf_token: string;
  expires_at: Date;
  revoked_at: Date | null;
};

const clinicSchema = new Schema<Clinic>(
  {
    ...uuidId,
    name: { type: String, required: true },
  },
  baseOptions,
);

const userSchema = new Schema<User>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    display_name: { type: String, required: true },
    role: { type: String, required: true, enum: ['doctor', 'admin'] },
    active: { type: Boolean, default: true },
  },
  baseOptions,
);
userSchema.index({ email: 1 }, { unique: true });

/**
 * Server-side sessions so that logout really invalidates the cookie (AT-19).
 * Only the hash of the session token is stored.
 */
const sessionSchema = new Schema<Session>(
  {
    ...uuidId,
    user_id: { type: String, required: true, index: true },
    clinic_id: { type: String, required: true },
    role: { type: String, required: true },
    token_hash: { type: String, required: true, unique: true },
    csrf_token: { type: String, required: true },
    expires_at: { type: Date, required: true },
    revoked_at: { type: Date, default: null },
  },
  baseOptions,
);

export const ClinicModel = model<Clinic>('Clinic', clinicSchema);
export const UserModel = model<User>('User', userSchema);
export const SessionModel = model<Session>('Session', sessionSchema);
