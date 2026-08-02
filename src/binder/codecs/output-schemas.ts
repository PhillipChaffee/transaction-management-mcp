import { z } from "zod";

/**
 * Output schemas for codecs whose normalized shape differs from generated OpenAPI schemas.
 * Attached only to the matching outputCodec tools — never weakens unrelated tools.
 */

export const BulkStreamOutputSchema = z
  .object({
    items: z.array(z.unknown()),
    truncated: z.boolean(),
    returnedItems: z.number().int().nonnegative(),
    limits: z
      .object({
        maxBulkItems: z.number().int().positive(),
        maxStructuredOutputBytes: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const OctetStreamOutputSchema = z
  .object({
    mediaType: z.string(),
    base64: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const ReplicaTimestampOutputSchema = z.record(z.string(), z.unknown());

export const EmptyValueOutputSchema = z
  .object({
    value: z.unknown().nullable(),
    warnings: z.array(z.string()).nullable().optional(),
    links: z.array(z.unknown()).nullable().optional(),
  })
  .strict();

export const NoContentOutputSchema = z
  .object({
    success: z.literal(true),
    status: z.literal(204),
  })
  .strict();
