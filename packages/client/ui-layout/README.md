# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: responsive AppFrame plus the `ctx.layout` viewing-state service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, and `conversation.empty`. At 1024px and above, AppFrame is the three-column shell with drag handles and a concession chain. The sidebar resize boundary is an invisible hit strip, while the details boundary retains its floating pill; only details shrinks during concession and then auto-closes. A closed desktop sidebar retains a 56px control rail while details closes to zero width. Below 1024px, AppFrame instead renders one full-width destination at a time: the Session list or the conversation. Entering a conversation pushes a same-URL browser History entry, so browser back and the platform edge-swipe gesture return to the full Session list before leaving DSH. The inactive destination remains mounted at zero width, and details and drag handles stay hidden in this mode. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

AppFrame always mounts the sidebar, conversation, and details columns; a connected Session renders through `SessionProvider`. The transient layout store starts the desktop sidebar at its default width and details closed, and it never reads or writes `localStorage`. Mobile History records only which destination is visible; Session selection remains in the runtime. Hero and other unselected states also derive a zero rendered details width without changing that stored preference. AppFrame retains the last non-blank Session id across those states: the first Session remains closed, an explicit details action opens the contract default width, returning to the same Session restores its unchanged width, and selecting a different Session closes details before paint. The conversation owner share is empty, while the sidebar owner share contains only `collapsed` and `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, and the four owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default and details closed; switching between distinct Session ids also closes details and forgets its dragged width, while unselected surfaces render details at zero width without modifying geometry.
- **Concession-chain auto-close derives a zero width without touching the preferred width** — the panel restores itself when the window widens; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
- **Mobile History does not encode a Session id in the URL** — reloading restores the runtime's selected Session and uses History only for list/conversation navigation.
