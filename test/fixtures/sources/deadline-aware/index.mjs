/**
 * Fixture source that honours the soft deadline: if the deadline has already
 * passed it stops immediately with no documents (the time-budgeted-batch
 * contract every scraping source adapter follows).
 */
export async function sync(context) {
  if (typeof context.deadline === 'number' && Date.now() >= context.deadline) {
    context.log.warn('deadline-aware: deadline reached, stopping');
    return { documents: [], cursor: context.cursor, stats: { fetched: 0, remaining: 1 } };
  }
  return { documents: [{ id: 'd-1', title: 'Done', text: 'within budget' }] };
}
