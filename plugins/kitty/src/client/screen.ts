/** Poll Kitty snapshots and forward gestures at the browser's scroll edges to its viewport. */
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { endpoint, request, type KittyList } from './catalog.ts';

interface Options {
  target: string;
  history: boolean;
  settings: KittyList | null;
  element: RefObject<HTMLPreElement>;
  onFailure: (error: unknown) => void;
  onFollow: (follow: boolean) => void;
}

/**
 * Own reads, bounded scroll batches and native gesture listeners for one selected terminal.
 * @param options - target, snapshot mode, Host limits, output element and current UI callbacks.
 * @returns rendered text, scroll progress and an action returning to the latest terminal output.
 */
export function useKittyScreen({ target, history, settings, element, onFailure, onFollow }: Options) {
  const [screen, setScreen] = useState('');
  const [scrolling, setScrolling] = useState(false);
  const callbacks = useRef({ onFailure, onFollow });
  callbacks.current = { onFailure, onFollow };
  const latest = useRef<() => void>();
  const scroll = settings?.scroll;
  const intervalMs = settings?.pollIntervalMs;

  useEffect(() => {
    setScreen('');
    setScrolling(false);
    const output = element.current;
    if (!target || !output || !scroll || intervalMs === undefined) return;
    let closed = false;
    let read: AbortController | undefined;
    let mutation: AbortController | undefined;
    let revision = 0;
    let pendingLines = 0;
    let jumpToEnd = false;
    let flushTimer: number | undefined;
    let touch: { id: number; x: number; y: number } | undefined;
    let gestureTarget: EventTarget | undefined;

    async function poll() {
      if (read || mutation || jumpToEnd || Math.abs(pendingLines) >= 1 || document.visibilityState !== 'visible') return;
      const controller = new AbortController();
      read = controller;
      const version = revision;
      try {
        const value = await request<{ text: string }>(`${endpoint}?token=${target}&extent=${history ? 'all' : 'screen'}`, { signal: controller.signal });
        if (!closed && !controller.signal.aborted && version === revision) setScreen(value.text);
      } catch (error) {
        if (!closed && !controller.signal.aborted) callbacks.current.onFailure(error);
      } finally { if (read === controller) read = undefined; }
    }
    function schedule() {
      if (closed || flushTimer !== undefined || (!jumpToEnd && Math.abs(pendingLines) < 1)) return;
      flushTimer = window.setTimeout(() => { flushTimer = undefined; void flush(); }, scroll!.debounceMs);
    }
    async function flush() {
      if (closed || mutation) return;
      const amount = jumpToEnd ? 'end' : Math.trunc(pendingLines);
      if (amount === 0) return;
      if (amount === 'end') jumpToEnd = false;
      else pendingLines -= amount;
      read?.abort();
      const version = ++revision;
      const controller = new AbortController();
      mutation = controller;
      setScrolling(true);
      callbacks.current.onFollow(false);
      try {
        const value = await request<{ text: string }>(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: target, action: 'scroll', amount }), signal: controller.signal,
        });
        if (!closed && !controller.signal.aborted && version === revision) {
          setScreen(value.text);
          if (amount === 'end') callbacks.current.onFollow(true);
        }
      } catch (error) {
        pendingLines = 0;
        jumpToEnd = false;
        if (!closed && !controller.signal.aborted) callbacks.current.onFailure(error);
      } finally {
        mutation = undefined;
        if (!closed) { setScrolling(false); schedule(); }
      }
    }
    function atEdge(delta: number) {
      const bottom = Math.max(0, output!.scrollHeight - output!.clientHeight);
      return delta < 0 ? output!.scrollTop <= 2 : output!.scrollTop >= bottom - 2;
    }
    function queue(lines: number) {
      pendingLines = Math.max(-scroll!.maxLines, Math.min(scroll!.maxLines, pendingLines + lines));
      callbacks.current.onFollow(false);
      schedule();
    }
    function wheel(event: WheelEvent) {
      if (history || event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (!atEdge(event.deltaY)) { pendingLines = 0; return; }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * output!.clientHeight : event.deltaY;
      queue(event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY : pixels / scroll!.pixelsPerLine);
    }
    function touchStart(event: TouchEvent) {
      touchEnd();
      const point = event.touches[0];
      if (event.touches.length !== 1 || !event.target) return;
      touch = { id: point.identifier, x: point.clientX, y: point.clientY };
      // Touch events retain their starting node even when a new snapshot replaces its ANSI span.
      gestureTarget = event.target;
      gestureTarget.addEventListener('touchmove', touchMove as EventListener, { passive: false });
      gestureTarget.addEventListener('touchend', touchEnd, { passive: true });
      gestureTarget.addEventListener('touchcancel', touchEnd, { passive: true });
    }
    function touchMove(event: TouchEvent) {
      if (history || !touch) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== touch.id) { touch = undefined; return; }
      const point = event.touches[0];
      const deltaY = touch.y - point.clientY;
      const deltaX = touch.x - point.clientX;
      touch = { id: point.identifier, x: point.clientX, y: point.clientY };
      if (!deltaY || Math.abs(deltaX) > Math.abs(deltaY)) return;
      if (!atEdge(deltaY)) { pendingLines = 0; return; }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      queue(deltaY / scroll!.pixelsPerLine * scroll!.touchSensitivity);
    }
    function touchEnd() {
      touch = undefined;
      gestureTarget?.removeEventListener('touchmove', touchMove as EventListener);
      gestureTarget?.removeEventListener('touchend', touchEnd);
      gestureTarget?.removeEventListener('touchcancel', touchEnd);
      gestureTarget = undefined;
    }
    latest.current = () => {
      if (history) { callbacks.current.onFollow(true); return; }
      pendingLines = 0;
      jumpToEnd = true;
      revision++;
      schedule();
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, intervalMs);
    const visible = () => { void poll(); };
    document.addEventListener('visibilitychange', visible);
    output.addEventListener('wheel', wheel, { passive: false });
    output.addEventListener('touchstart', touchStart, { passive: true });
    return () => {
      closed = true;
      latest.current = undefined;
      read?.abort();
      mutation?.abort();
      window.clearInterval(timer);
      window.clearTimeout(flushTimer);
      document.removeEventListener('visibilitychange', visible);
      output.removeEventListener('wheel', wheel);
      output.removeEventListener('touchstart', touchStart);
      touchEnd();
    };
  }, [target, history, element, intervalMs, scroll?.debounceMs, scroll?.pixelsPerLine, scroll?.touchSensitivity, scroll?.maxLines]);

  return { screen, scrolling, latest: () => latest.current?.() };
}
