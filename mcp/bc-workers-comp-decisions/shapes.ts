/**
 * Shared wire shapes and facet vocabularies for the BC Workers' Comp Decisions
 * server modules.
 */

/** The WCAT `application_type` facet values (appeal/application type). */
export const WCAT_APPLICATION_TYPES = [
  'compensation',
  'relief-of-costs',
  'certification-to-court',
  'prohibited-action',
  'assessment',
  'prevention',
  'reopening',
  'reconsideration',
  'general',
] as const;

/** The WCAT `document_type` facet values (decision/document type). */
export const WCAT_DOCUMENT_TYPES = [
  'merit',
  'extension-of-time',
  'other',
  'reconsideration',
  'withdrawal',
  'certification-to-court',
  'stay',
  'suspension',
  'summary',
] as const;

/** The WCAT `classification` facet values. */
export const WCAT_CLASSIFICATIONS = ['general', 'noteworthy', 'precedent'] as const;

/** One WCAT decision projected onto the wire shape. */
export interface WcatDecision {
  /** Decision number, e.g. "A2002996" (2016+) or "2012-00718" (pre-2016). */
  number: string;
  /** Decision date (ISO), or null when unparseable. */
  date: string | null;
  /** Appeal or application type, e.g. "Compensation". */
  applicationType: string | null;
  /** Decision or document type, e.g. "Merit". */
  documentType: string | null;
  /** WCAT's one-line "Issues under appeal" summary. */
  issues: string | null;
  /** Stable link to the official decision PDF. */
  pdfUrl: string;
}

/** One WorkSafeBC Review Division decision projected onto the wire shape. */
export interface ReviewDecision {
  /** Review reference number, e.g. "R0295253". */
  number: string;
  /** Decision date (ISO), or null when unparseable. */
  date: string | null;
  /** WorkSafeBC's highlighted result snippet. */
  snippet: string | null;
}
