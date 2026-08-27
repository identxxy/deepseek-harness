# @deepseek-ai/dsh-client-ui-console

English | [中文](README.zh.md)

Browser plugin for tmux-backed Human Terminals. It owns the Console catalog mirror, ephemeral attachment capabilities, xterm renderer, Workspace navigation rows, creation action, lifecycle menus, and mobile terminal key bar. Closing a pane or unloading the browser plugin detaches only the Web tmux Client; archive leaves the workload running, while confirmed termination removes the navigation row and every pane for that Console.

Desktop navigation opens a Console in the active Actor pane or an adjacent split. Narrow layouts show only the focused Actor and use the shell's browser-history navigation to return to the unified Agent and Human Terminal list. The pane tree is device-local browser state; attachment capabilities stay only in the live plugin instance.

The Host injects the required `catalogRefreshIntervalMs` deployment setting into the browser bootstrap. Catalog refresh has one current list request and at most one deferred request shared by demand arriving during that request, so every caller waits for one bounded request even when the interval is shorter than list latency. A background refresh preserves an already complete ready catalog for React observers; a failed refresh remains error until a later request succeeds. Superseded connection or mutation responses cannot publish. The browser reconciles navigation and pane references only from a ready, complete catalog: running Consoles remain available, including archived workloads with an open pane, while ended or missing Consoles disappear from navigation and every split. An attachment that observes workload termination requests an immediate catalog refresh; a failed request leaves its ended phase visible and the bounded periodic refresh retries cleanup. Catalog mutations execute in invocation order. Remote mutation success, local point projection, and complete-catalog recovery are separate results: a point mutation over a previously complete baseline publishes the patched catalog as ready even after a background refresh error, while connection reset clears that completeness and requires recovery. Required recovery failure is reported without changing the successful mutation result. A connection reset invalidates all old bearer capabilities and pending mutation results locally, aborts browser waits for catalog mutations, list requests, and attachment I/O without changing Remote wire signatures, increments the observable connection epoch, and makes every mounted terminal pane establish a fresh attachment. Plugin disposal applies the same browser-side cancellation and waits for the resulting local settlements, so an unresponsive carrier cannot keep teardown pending.

Input writes are strictly FIFO per attachment. An uncertain write failure poisons that write lane so later command fragments are rejected instead of being sent after an unknown prefix. Resize requests are serialized and queued dimensions may coalesce to the newest size. Every attachment Remote wait has browser-side cancellation even when its carrier ignores the existing signal. Pane cleanup and plugin disposal share at most one detach Remote call; disposal memoizes one cleanup result, cancels hung attach, read, write, resize, and detach waits, and settles only after all tracked browser work reaches quiescence. Once disposal starts, public detach calls may only join an existing detach or observe an already detached attachment; unknown access is rejected without creating a lane or Remote work. The underlying carrier promises remain consumed if they reject later.

## Model Experience

### Human Terminal browser surfaces

#### What the model sees

Nothing. `ctx.consoleClient` registers no model tool, prompt section, or Agent Session event.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the package never changes a request prefix.

## Known Limitations and Deferred Work

- Terminal output currently uses bounded long polling rather than a duplex browser stream.
- Concurrent Web and native tmux Clients may type at the same time; the UI does not claim exclusive control.
- Rename and terminate confirmation use native browser dialogs in the first product version.
