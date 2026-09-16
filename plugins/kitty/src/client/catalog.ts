/** Authenticated Kitty requests and the shared, replaceable window catalog. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';

/** Window metadata and the Host-issued token for its current foreground process. */
export interface Pane { instance: string; token: string; id: number; title: string; cwd: string; program: string; pid: number }
/** Authenticated catalog response, including Host-configured Client limits. */
export interface KittyList {
  panes: Pane[];
  pollIntervalMs: number;
  maxImageBytes: number;
  scroll: { debounceMs: number; pixelsPerLine: number; touchSensitivity: number; maxLines: number };
}
/** Same-origin route protected by the Host's device and connection checks. */
export const endpoint = '/api/dsh/kitty';

/**
 * Read one Kitty response; failed mutations are never retried.
 * @param url - Kitty route and optional screen query.
 * @param init - request method, input and cancellation signal.
 * @returns the parsed response; rejects on HTTP, network or JSON errors.
 */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 404) throw new Error('kitty_endpoint_unavailable');
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'kitty_operation_failed');
  return value as T;
}

/** Own catalog requests across sidebar and terminal remounts. */
export class KittyCatalog {
  /** Latest catalog and request status, bound to renderer-owned hooks. */
  readonly source = createSnapshotStore<{ value: KittyList | null; loading: boolean; failed: boolean }>({ value: null, loading: false, failed: false });
  #controller: AbortController | undefined;
  #currentPromise: Promise<void> | undefined;
  #pending = new Set<Promise<void>>();

  /**
   * Reuse the current read, or refresh the retained catalog when idle.
   * @returns the current or newly started catalog read.
   */
  load(): Promise<void> {
    return this.#currentPromise ?? this.refresh();
  }

  /**
   * Refresh the list, publishing only the latest request's result.
   * @returns completion after publishing the list or its failure status.
   */
  refresh(): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.source.update(d => { d.loading = true; d.failed = false; });
    const pending = request<KittyList>(endpoint, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) this.source.set({ value, loading: false, failed: false });
    }, () => {
      if (!controller.signal.aborted) this.source.update(d => { d.loading = false; d.failed = true; });
    });
    this.#currentPromise = pending;
    this.#pending.add(pending);
    void pending.finally(() => {
      this.#pending.delete(pending);
      if (this.#currentPromise === pending) this.#currentPromise = undefined;
    });
    return pending;
  }

  /**
   * Abort catalog reads and wait until their callbacks settle.
   * @returns completion after all outstanding reads settle.
   */
  async dispose(): Promise<void> {
    this.#controller?.abort();
    await Promise.all(this.#pending);
  }
}
