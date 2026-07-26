import { z } from '@ontrove/mcp';

/**
 * The shapes Our World in Data actually sends back.
 *
 * Deliberately lenient — every field is `nullish()` and unknown keys are
 * dropped. These parse the UPSTREAM envelope, which can change without notice;
 * the strict contract this toolkit promises its callers lives beside each tool,
 * not here.
 */

export const columnWire = z.object({
  titleShort: z.string().nullish(),
  titleLong: z.string().nullish(),
  descriptionShort: z.string().nullish(),
  descriptionProcessing: z.string().nullish(),
  shortName: z.string().nullish(),
  unit: z.string().nullish(),
  shortUnit: z.string().nullish(),
  timespan: z.string().nullish(),
  lastUpdated: z.string().nullish(),
  nextUpdate: z.string().nullish(),
  owidVariableId: z.number().nullish(),
  citationShort: z.string().nullish(),
  citationLong: z.string().nullish(),
  fullMetadata: z.string().nullish(),
  type: z.string().nullish(),
});

export const chartMetadataWire = z.object({
  chart: z
    .object({
      title: z.string().nullish(),
      subtitle: z.string().nullish(),
      citation: z.string().nullish(),
      originalChartUrl: z.string().nullish(),
      selection: z.array(z.string()).nullish(),
    })
    .nullish(),
  columns: z.record(z.string(), columnWire).nullish(),
  dateDownloaded: z.string().nullish(),
});
const licenseWire = z.object({ name: z.string().nullish(), url: z.string().nullish() });

export const indicatorMetadataWire = z.object({
  id: z.number().nullish(),
  name: z.string().nullish(),
  unit: z.string().nullish(),
  catalogPath: z.string().nullish(),
  datasetName: z.string().nullish(),
  descriptionShort: z.string().nullish(),
  updatePeriodDays: z.number().nullish(),
  /**
   * OWID's own machine-readable redistribution gate. When true the CSV endpoint
   * 403s — they enforce the upstream provider's terms server-side rather than
   * leaving it to callers.
   */
  nonRedistributable: z.boolean().nullish(),
  license: licenseWire.nullish(),
  origins: z
    .array(
      z.object({
        producer: z.string().nullish(),
        citationFull: z.string().nullish(),
        urlMain: z.string().nullish(),
        dateAccessed: z.string().nullish(),
        license: licenseWire.nullish(),
      }),
    )
    .nullish(),
  dimensions: z
    .object({
      entities: z
        .object({
          values: z
            .array(
              z.object({
                id: z.number().nullish(),
                name: z.string().nullish(),
                code: z.string().nullish(),
              }),
            )
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
export const searchChartsWire = z.object({
  query: z.string().nullish(),
  nbHits: z.number().nullish(),
  page: z.number().nullish(),
  nbPages: z.number().nullish(),
  hitsPerPage: z.number().nullish(),
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        slug: z.string().nullish(),
        subtitle: z.string().nullish(),
        variantName: z.string().nullish(),
        type: z.string().nullish(),
        availableEntities: z.array(z.string()).nullish(),
        availableTabs: z.array(z.string()).nullish(),
        publishedAt: z.string().nullish(),
        updatedAt: z.string().nullish(),
        url: z.string().nullish(),
      }),
    )
    .nullish(),
});
export const semanticSearchWire = z.object({
  query: z.string().nullish(),
  total_results: z.number().nullish(),
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        indicator_id: z.number().nullish(),
        snippet: z.string().nullish(),
        description: z.string().nullish(),
        score: z.number().nullish(),
        popularity: z.number().nullish(),
        n_charts: z.number().nullish(),
        catalog_path: z.string().nullish(),
        metadata: z
          .object({
            unit: z.string().nullish(),
            chart_count: z.number().nullish(),
            // Bulk access, already in the payload: the Parquet table backing
            // this indicator, the column inside it, and a runnable DuckDB
            // query. Dropping these would make callers re-derive them.
            parquet_url: z.string().nullish(),
            column: z.string().nullish(),
            run_sql_template: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});
