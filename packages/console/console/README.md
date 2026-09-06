---
description: "Create and manage durable Human Terminals independently of Agent-owned terminal sessions."
kind: "package-reference"
---
# @deepseek-ai/dsh-console

English | [中文](README.zh.md)

## Summary

Create and manage durable Human Terminals independently of Agent-owned terminal sessions.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `ctx.consoles` Service Definition manages durable Console workloads and ephemeral viewer attachments separately. Catalog operations list, create, rename, archive, restore, and terminate workloads under the deployment’s authenticated ingress. Each attachment receives its own id and bearer capability; terminal I/O requires both.

Workload snapshots expose Workspace, cwd, title, creation time, archive state, and process status. Attachment snapshots expose terminal dimensions, process status, and absolute output offsets without the capability. Cursor-based output reads return bounded pages or explicit gaps; invalid cursors fail with `INVALID_CURSOR`.

`detach()` releases one viewer. `terminate()` ends the workload and its attachments. See the [Console subsystem](../../../docs/subsystems/console.md) for identity and lifetime semantics.

<a id="model-experience"></a>
## Model Experience

### Host console state

#### What the model sees

Nothing. `ctx.consoles` registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the package never changes a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- The seam provides no exclusive input lease: concurrent viewers may write to the same workload.

No runtime invariant companion is published because the abstract Console service owns no provider state.

<a id="dev-note"></a>
### Dev Note

None.
