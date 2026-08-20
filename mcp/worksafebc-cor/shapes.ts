import { z } from '@ontrove/extend/toolkit';

/** Shared wire shapes for the WorkSafeBC COR server modules. */

/**
 * COR type codes, expanded to labels.
 *
 * `OHS` is the only code observed: 739 certificate rows sampled across five
 * certifying partners (BCCSA, BCMSA, BCFSC, Energy Safety Canada, AgSafe) were
 * `OHS` without exception. An earlier version of this map also expanded `RTW`
 * and `IDM` — neither appears in WorkSafeBC's data or its documentation, and
 * inventing a label risks putting a confident English name on a future code
 * that means something else. Anything unrecognized now passes through verbatim.
 */
export const COR_TYPE_LABEL: Record<string, string> = {
  OHS: 'Occupational Health & Safety',
};

/** Expand a COR type code to its label, keeping an unknown code verbatim. */
export const corTypeLabel = (code: string | null): string | null =>
  code === null ? null : (COR_TYPE_LABEL[code] ?? code);

/** One employer in a name-search result. */
export interface EmployerHit {
  employerId: number | null;
  accountNumber: string | null;
  legalName: string | null;
  tradeName: string | null;
  url: string | null;
}

/** One classification unit (WorkSafeBC's industry-rate classification). */
export interface ClassificationUnit {
  code: string;
  description: string | null;
}

/** One certificate on an employer's details page. */
export interface Certificate {
  certifyingPartner: string | null;
  corType: string | null;
  certificateNumber: string | null;
  expiryDate: string | null;
  expired: boolean | null;
  classificationUnits: ClassificationUnit[];
}

/** One row of the certifying-partner grid — an employer with its certificate inline. */
export interface PartnerCertifiedEmployer extends EmployerHit {
  corType: string | null;
  certificateNumber: string | null;
  expiryDate: string | null;
  expired: boolean | null;
  classificationUnits: string[];
}

export const employerShape = {
  employerId: z.number().nullable(),
  accountNumber: z.string().nullable(),
  legalName: z.string().nullable(),
  tradeName: z.string().nullable(),
  url: z.string().nullable(),
};

export const certificateShape = {
  certifyingPartner: z.string().nullable(),
  corType: z.string().nullable(),
  certificateNumber: z.string().nullable(),
  expiryDate: z.string().nullable(),
  expired: z.boolean().nullable(),
  classificationUnits: z.array(z.object({ code: z.string(), description: z.string().nullable() })),
};

export const partnerCertifiedEmployerShape = {
  ...employerShape,
  corType: z.string().nullable(),
  certificateNumber: z.string().nullable(),
  expiryDate: z.string().nullable(),
  expired: z.boolean().nullable(),
  classificationUnits: z.array(z.string()),
};
