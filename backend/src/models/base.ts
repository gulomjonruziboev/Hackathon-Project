import { randomUUID } from 'node:crypto';

/** Spec 8: every primary object carries a UUID identifier, exposed as `id`. */
export const uuidId = {
  _id: { type: String, default: () => randomUUID() },
} as const;

/**
 * Shared schema options. Models declare an explicit TypeScript interface and
 * pass it to `new Schema<T>(...)`, so the document type never depends on
 * Mongoose inferring it back out of the definition object.
 */
export const baseOptions = {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false as const,
  toJSON: {
    virtuals: true,
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret.id = ret._id;
      delete ret._id;
      return ret;
    },
  },
  toObject: { virtuals: true },
};

/** Fields every stored entity gets from `timestamps` plus the UUID `_id`. */
export type BaseFields = {
  _id: string;
  created_at: Date;
  updated_at: Date;
};
