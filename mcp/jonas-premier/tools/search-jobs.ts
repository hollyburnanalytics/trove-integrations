import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { boolish, pageInput, str, uuid } from '../fields.ts';

/**
 * `search_jobs` — jobs (projects) in one company, yielding the jobId/jobNumber
 * the job-cost, estimate, and subcontract tools consume.
 */
export const searchJobs: ToolDefinition = {
  name: 'search_jobs',
  title: 'Premier: Search jobs',
  description:
    'Find jobs (projects) in one company by number, name, or keyword. Returns job id, ' +
    'number, name, status, and address — the jobId/jobNumber feed the job-cost, estimate, ' +
    'and subcontract tools.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    companyId: uuid('Company Id (from list_companies).'),
    jobNumber: z.string().optional().describe('Filter by exact job number.'),
    jobName: z.string().optional().describe('Filter by job name.'),
    status: z
      .enum(['Active', 'All'])
      .default('Active')
      .describe('Job status filter (default Active).'),
    search: z.string().optional().describe('Keyword search across jobs.'),
    ...pageInput,
  }),
  output: z.object({
    count: z.number(),
    jobs: z.array(
      z.object({
        jobId: z.string().nullable(),
        jobNumber: z.string().nullable(),
        jobName: z.string().nullable(),
        jobStatus: z.string().nullable(),
        active: z.boolean().nullable(),
        city: z.string().nullable(),
        zipCode: z.string().nullable(),
      }),
    ),
  }),
  async handler(args, ctx) {
    ctx.log('search_jobs', { companyId: args.companyId, search: args.search });
    const rows = await jonasGet(
      '/api/Job/GetJobs',
      {
        companyId: args.companyId,
        jobNumber: args.jobNumber,
        jobName: args.jobName,
        status: args.status,
        search: args.search,
        pageNumber: args.page,
        pageSize: args.pageSize,
      },
      ctx,
    );
    const jobs = rows.map((r) => ({
      jobId: str(r, 'JobId'),
      jobNumber: str(r, 'JobNumber'),
      jobName: str(r, 'JobName'),
      jobStatus: str(r, 'JobStatus'),
      active: boolish(r, 'Active'),
      city: str(r, 'City'),
      zipCode: str(r, 'ZipCode'),
    }));
    if (jobs.length === 0) {
      return { text: 'No jobs matched.', structured: { count: 0, jobs: [] } };
    }
    const lines = jobs
      .map((j) => `  ${j.jobNumber ?? '?'} — ${j.jobName ?? '?'} [${j.jobStatus ?? '?'}]`)
      .join('\n');
    return {
      text: `${jobs.length} job(s):\n${lines}`,
      structured: { count: jobs.length, jobs },
    };
  },
};
