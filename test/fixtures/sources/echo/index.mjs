/**
 * Fixture source: emits two documents, exercising ctx.log and ctx.progress.
 * Used by the harness contract tests; not a real source.
 */
export async function sync(context) {
  context.log.info('echo: starting');
  context.progress(0, 'echo: working');
  const documents = [
    { id: 'echo-1', title: 'First', text: 'hello' },
    { id: 'echo-2', title: 'Second', text: 'world' },
  ];
  context.log.info(`echo: produced ${documents.length}`);
  return { documents, cursor: 'echo-cursor', stats: { fetched: documents.length } };
}

/** Query method, so the harness `method: 'query'` path is covered. */
export async function query(context) {
  context.progress(0, 'echo: query');
  return { documents: [{ id: 'q-1', title: 'Q', text: 'queried' }] };
}
