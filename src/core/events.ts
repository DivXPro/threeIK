export interface WarningPayload {
  key: string;
  message: string;
}

type Listener = (payload?: unknown) => void;

export class TinyEmitter<Events extends string> {
  private listeners = new Map<Events, Set<Listener>>();
  private warnedKeys = new Set<string>();

  on(event: Events, cb: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => this.off(event, cb);
  }

  off(event: Events, cb: Listener): void {
    this.listeners.get(event)?.delete(cb);
  }

  emit(event: Events, payload?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  }

  /** Emits a 'warning' event once per key until clearWarnings() is called. */
  warnOnce(key: string, message: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    this.emit('warning' as Events, { key, message } satisfies WarningPayload);
  }

  clearWarnings(): void {
    this.warnedKeys.clear();
  }
}
