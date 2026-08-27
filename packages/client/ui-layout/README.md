# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: responsive AppFrame plus the `ctx.layout` viewing-state service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, `conversation.empty`, `shell.overlay`, and `workspace.console`. At 1024px and above, AppFrame is the three-column shell with drag handles and a concession chain. Its center column renders a recursive pane tree whose leaves address either an Agent Session or a Human Console. Leaves can replace their actor, split right or down, close, focus, and resize dividers within a 20–80 percent range. The sidebar resize boundary is an invisible hit strip, while the details boundary retains its floating pill; only details shrinks during concession and then auto-closes. A closed desktop sidebar retains a 56px control rail while details closes to zero width. Below 1024px, AppFrame renders the focused actor as one full-width destination. Browser back and the platform edge-swipe gesture return to the unified Agent and Human Terminal list before leaving DSH; split controls, details, and drag handles remain hidden. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

AppFrame always mounts the sidebar, actor canvas, and details columns. Before a pane tree exists, a stable implicit Agent scaffold adopts the first selected Session without replacing the conversation DOM or persisting layout state; the first split materializes the addressed pane tree. Agent leaves render through an explicitly addressed `SessionProvider`; Console leaves render through the `workspace.console` slot, so two panes do not share one implicit current Session. The store persists only the versioned pane tree and active leaf in device-local browser storage. It validates exact fields, actor tags, unique ids, depth, node count, ratios, and the active leaf before restore; invalid data falls back to a fresh layout. Panel widths and responsive navigation remain transient. Mobile History records only which destination is visible. The inactive mobile destination stays mounted at viewport width but is invisible and non-interactive, preserving its scroll and local layout state without a zero-width reflow; mobile destination changes are immediate because desktop column interpolation cannot coexist with a viewport-width center. Selecting an Agent pane makes it the global current Session for details and navigation, while selecting a Console does not manufacture an Agent Session. The conversation owner share is empty, while the sidebar owner share contains only `collapsed` and `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

Pane chrome uses semantic-neutral containers so the nested conversation header retains the page banner landmark. Actor labels, unavailable state, and split/close controls follow the active Web locale.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, and the four owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default and details closed; switching between distinct Session ids also closes details and forgets its dragged width. Pane splits and the active actor are device-local persisted state.
- **Concession-chain auto-close derives a zero width without touching the preferred width** — the panel restores itself when the window widens; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
- **Mobile History does not encode an actor id in the URL** — reloading restores the device-local pane selection and uses History only for list/actor navigation.
- **Catalog owners reconcile stale actor references explicitly** — `ctx.layout.reconcileActorCatalog(kind, availableIds)` atomically removes every pane occurrence absent from that kind's complete catalog, collapses surviving splits, preserves a surviving active pane, and returns an empty mobile workspace to the Session list.
