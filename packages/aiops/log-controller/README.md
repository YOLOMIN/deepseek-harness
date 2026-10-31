---
description: "Agent activity logs for the GAC2 operations console: session-log projection with filtered paging over the aiopsLogs namespace."
kind: "package-reference"
---

# @gac2/dsh-aiops-log-controller

English | [中文](README.zh.md)

## Summary

Mount the agent-activity log query for the GAC2 operations console. The package projects committed session events of the console-managed agents (plus the inner A2A delegation targets) into log rows — turn boundaries, committed model output, interrupted attempts, and tool results paired with their calls — and serves filtered, paged queries through the `aiopsLogs` Remote namespace. Reads compute from the durable session logs on every query; there is no shadow store to drift, and the console's detail action opens the owning session's trace.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-log-controller` in the Web composition (see `aiops.patch.yml`) beside `@gac2/dsh-aiops-agent-controller` and the session query service. Configuration fields are `maxSessions` (newest sessions inspected per query, default 30) and `innerPresetIds` (delegation target presets also feeding the view, default `sys-agent`/`hpc-agent`). The console queries through `ctx.remote.aiopsLogs.query({ keyword, kind, fromMs, page, pageSize })` and opens the owning session's trace for details.

## Model Experience

None, as the package only reads committed session logs and never constructs model input.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Each query rereads the newest `maxSessions` session logs; a generated projection store is deferred until volumes justify it.
- Knowledge-retrieval (RAG) rows appear once the recall pipeline commits its own session events.
- Log detail stays in the owning session's trace view; the module does not duplicate a full log browser.

<a id="dev-note"></a>
### Dev Note

Query input is validated with zod at the Remote boundary; the projection is a pure committed-event → log-row mapping, and tool names are recovered by pairing tool/call with tool/result through their toolCallId.
