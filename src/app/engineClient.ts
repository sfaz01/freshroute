import type { Op, OpArgs, OpResult } from './protocol';

type Progress = (done: number, total: number, label?: string) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: Progress;
}

/** Promise-based RPC to the engine worker. */
class EngineClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data as { id: number; ok?: boolean; result?: unknown; error?: string; progress?: { done: number; total: number; label?: string } };
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.progress) {
        p.onProgress?.(msg.progress.done, msg.progress.total, msg.progress.label);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'Engine error'));
    };
    w.onerror = (e) => {
      const err = new Error(e.message || 'The engine worker crashed.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  call<K extends Op>(op: K, args: OpArgs[K], onProgress?: Progress): Promise<OpResult[K]> {
    const id = ++this.seq;
    const w = this.ensure();
    return new Promise<OpResult[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      w.postMessage({ id, op, args });
    });
  }
}

export const engine = new EngineClient();
