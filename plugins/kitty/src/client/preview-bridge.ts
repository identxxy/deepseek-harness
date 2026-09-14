/** Sandboxed report navigation and read-only fetch bridge; no Host credential enters the document. */
const BRIDGE_SOURCE = String.raw`function installBridge(channel, baseUrl) {
    let nextId = 0;
    const nativeFetch = window.fetch.bind(window);
    const pending = new Map();
    const resolve = (url) => new URL(url, document.querySelector('base[href]')?.href || baseUrl).href;
    const scrollToHash = (hash) => {
        if (!hash) return;
        let id;
        try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
        (document.getElementById(id) || document.getElementsByName(id)[0])?.scrollIntoView();
    };
    window.addEventListener('load', () => scrollToHash(new URL(baseUrl).hash));
    const navigate = (url) => {
        const destination = new URL(url, baseUrl);
        const source = new URL(baseUrl);
        source.hash = '';
        const hash = destination.hash;
        destination.hash = '';
        if (hash && destination.href === source.href) {
            scrollToHash(hash);
            return;
        }
        parent.postMessage({ channel, type: 'navigate', url: resolve(url) }, '*');
    };
    document.addEventListener('click', event => {
        const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!link)
            return;
        event.preventDefault();
        navigate(link.getAttribute('href'));
    }, true);
    document.addEventListener('submit', event => {
        event.preventDefault();
        const form = event.target;
        if (!(form instanceof HTMLFormElement))
            return;
        if (form.method.toLowerCase() !== 'get') {
            parent.postMessage({ channel, type: 'failure' }, '*');
            return;
        }
        const url = new URL(form.getAttribute('action') || baseUrl, baseUrl);
        url.search = new URLSearchParams([...new FormData(form)].map(([key, value]) => [key, typeof value === 'string' ? value : value.name])).toString();
        navigate(url.href);
    }, true);
    window.fetch = (input, init) => {
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            parent.postMessage({ channel, type: 'failure' }, '*');
            return Promise.reject(new TypeError('Report requests must use GET or HEAD'));
        }
        const url = resolve(input instanceof Request ? input.url : String(input));
        if (/^(?:data|blob):/.test(url)) return nativeFetch(input, init);
        const id = ++nextId;
        return new Promise((resolveResponse, reject) => {
            pending.set(id, { resolve: resolveResponse, reject });
            parent.postMessage({ channel, type: 'resource', id, url, method }, '*');
        });
    };
    window.addEventListener('message', event => {
        const message = event.data;
        if (event.source !== parent || !message || message.channel !== channel || message.type !== 'resource-result' || !Number.isSafeInteger(message.id))
            return;
        const request = pending.get(message.id);
        if (!request)
            return;
        pending.delete(message.id);
        if (typeof message.error === 'string') {
            request.reject(new Error(message.error));
            return;
        }
        if (typeof message.data !== 'string' || typeof message.contentType !== 'string' || typeof message.url !== 'string' || !Number.isInteger(message.status)) {
            request.reject(new TypeError('Invalid report resource'));
            return;
        }
        try {
            const bytes = Uint8Array.from(atob(message.data), character => character.charCodeAt(0));
            const response = new Response(message.method === 'HEAD' || [204, 205, 304].includes(message.status) ? null : bytes, {
                status: message.status, headers: { 'content-type': message.contentType },
            });
            Object.defineProperty(response, 'url', { value: message.url });
            request.resolve(response);
        }
        catch (error) {
            request.reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}`;

/**
 * Insert the bridge before report scripts run; scope tokens remain in the parent.
 * @param html - Host-prepared report HTML.
 * @param channel - identity unique to this mounted document.
 * @param url - final report URL used to resolve navigation.
 * @returns sandbox document with its navigation bridge.
 */
export function previewDocument(html: string, channel: string, url: string): string {
  const safe = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  const bridge = `<script>(${BRIDGE_SOURCE})(${safe(channel)},${safe(url)});</script>`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, head => head + bridge)
    : bridge + html;
}
