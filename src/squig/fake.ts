/**
 * An in-memory Squig for tests: the adapter's contract suite and the service tests run against
 * it, so they need no companion. Test-only — excluded from the package build.
 */
import type { SquigConnection, SquigDocument, SquigNode, SquigOp } from './session.js';

/** Squig's local store, as far as the adapter can see it: one document, ops applied in order. */
export class FakeSquig implements SquigConnection {
  doc: SquigDocument = { nodes: {}, order: [] };
  editorUrl = 'http://127.0.0.1:1/?local=1#token=t';
  closed = false;
  async read() {
    return { revision: 1, document: structuredClone(this.doc) };
  }
  async edit(ops: SquigOp[]) {
    for (const op of ops) {
      if (op.op === 'add') {
        for (const n of op.nodes) {
          const node = { x: 0, y: 0, w: 120, h: 40, ...n } as SquigNode;
          this.doc.nodes[node.id] = node;
          this.doc.order.push(node.id);
        }
      } else if (op.op === 'update') {
        for (const { id, patch } of op.patches) Object.assign(this.doc.nodes[id]!, patch);
      } else {
        for (const id of op.ids) {
          delete this.doc.nodes[id];
          this.doc.order = this.doc.order.filter((o) => o !== id);
          // Squig unbinds an arrow from a deleted endpoint rather than deleting it.
          for (const n of Object.values(this.doc.nodes)) {
            if (n.bind)
              n.bind = n.bind.map((b) => (b === id ? null : b)) as [string | null, string | null];
          }
        }
      }
    }
  }
  async close() {
    this.closed = true;
  }
  calls: Array<[string, Record<string, unknown>]> = [];
  async tool(name: string, args: Record<string, unknown>) {
    this.calls.push([name, args]);
    if (name === 'edit_document') {
      const before = new Set(Object.keys(this.doc.nodes));
      await this.edit(args['operations'] as SquigOp[]);
      return { createdIds: Object.keys(this.doc.nodes).filter((id) => !before.has(id)) };
    }
    return { ok: true };
  }
}
