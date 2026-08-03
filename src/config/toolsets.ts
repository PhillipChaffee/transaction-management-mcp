/**
 * Public toolset identifiers and default enablement.
 *
 * Operation membership is owned exclusively by the generated operations manifest.
 * This module lists only the 19 public ids and the nine default toolset ids.
 */

export const TOOLSET_IDS = [
  "reference",
  "users",
  "sales",
  "listings",
  "contacts",
  "listing_contacts",
  "checklists",
  "stages",
  "offices",
  "sale_contacts",
  "sale_documents",
  "listing_documents",
  "sale_commissions",
  "listing_commissions",
  "sale_parties",
  "listing_parties",
  "v2_sales",
  "v2_listings",
  "bulk_export",
] as const;

export type ToolsetId = (typeof TOOLSET_IDS)[number];

export const DEFAULT_TOOLSET_IDS = [
  "reference",
  "users",
  "sales",
  "listings",
  "contacts",
  "listing_contacts",
  "checklists",
  "stages",
  "offices",
] as const satisfies readonly ToolsetId[];

export type DefaultToolsetId = (typeof DEFAULT_TOOLSET_IDS)[number];

export function isToolsetId(value: string): value is ToolsetId {
  return (TOOLSET_IDS as readonly string[]).includes(value);
}
