// Zod validation schemas for API request bodies.
// Used in API routes to validate input before database operations.

import { z } from 'zod';

/** Maximum field lengths — protects against accidental huge payloads. */
export const LIMITS = {
  name: 200,
  description: 1000,
  tags: 500,
  document: 5_000_000, // 5MB max for circuit JSON
} as const;

/** Schema for POST /api/circuits (create). */
export const createCircuitSchema = z.object({
  name: z.string().min(1).max(LIMITS.name),
  description: z.string().max(LIMITS.description).optional().default(''),
  document: z.unknown()
    .refine((v) => v !== undefined, 'document is required')
    .transform((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? {}))),
  tags: z.string().max(LIMITS.tags).optional().default(''),
  isExample: z.boolean().optional().default(false),
});

/** Schema for PUT /api/circuits/[id] (partial update). */
export const updateCircuitSchema = z.object({
  name: z.string().min(1).max(LIMITS.name).optional(),
  description: z.string().max(LIMITS.description).optional(),
  document: z.unknown()
    .transform((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? {})))
    .optional(),
  tags: z.string().max(LIMITS.tags).optional(),
  isExample: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update',
});

/** Schema for SPICE import. */
export const spiceImportSchema = z.object({
  netlist: z.string().min(1).max(1_000_000), // 1MB max
});

/** Type exports for use in routes. */
export type CreateCircuitInput = z.infer<typeof createCircuitSchema>;
export type UpdateCircuitInput = z.infer<typeof updateCircuitSchema>;
export type SpiceImportInput = z.infer<typeof spiceImportSchema>;
