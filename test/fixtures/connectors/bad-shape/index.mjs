/**
 * Fixture connector returning an invalid shape. `config.mode` selects which
 * contract violation to produce, so one fixture covers several invalid cases.
 */
export async function sync(context) {
  switch (context.config.mode) {
    case 'undefined':
      return undefined;
    case 'documents-not-array':
      return { documents: 'nope' };
    case 'doc-not-object':
      return { documents: [42] };
    default:
      // Missing string `text` on an otherwise valid document.
      return { documents: [{ id: 'x', title: 'X', text: 123 }] };
  }
}
