---
description: "MCP server management for the GAC2 operations console: Nacos MCP-registry listing merged with live connect state, dynamic mcp-client mount/dispose over the aiopsMcp namespace."
kind: "package-reference"
---

# @gac2/dsh-aiops-mcp-controller

English | [中文](README.zh.md)

## Summary

Mount MCP server management for the GAC2 operations console. The controller lists servers from the deployment's Nacos MCP registry read surface (`/v0/servers`), merges each row with the live connection state, and connects/disconnects servers through the `aiopsMcp` Remote namespace. Connecting handshakes the endpoint (initialize + tools/list) and mounts a `dsh-mcp-client` instance, so the server's tools become callable by agents without a restart; disconnecting disposes the mount.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-mcp-controller` in the Web composition (see `aiops.patch.yml`). Configuration fields: `registryOrigin` (required, e.g. `http://192.168.10.95:9080`), `namespaceId` (default `public`), `authToken` (default empty; bearer token attached when connecting), `consoleOrigin`/`consoleUsername`/`consolePassword` (Nacos console account for register/unregister writes), `settingsPath` (default `~/.dsh/aiops-mcp-registry.json`), `requestTimeoutMs` (default 15000), `consoleTimeoutMs` (default 60000; console writes run slower under load). The console queries through `ctx.remote.aiopsMcp.list`, reads one server through `detail`, connects/disconnects by server name, and registers new servers through `register` (the endpoint is handshaken to discover its tools before the console API write) / `unregister`. The registry dialog and the invocation switch read/write through `getSettings`/`saveSettings`; overrides persist beside the DSH user root and apply on save. Switching invocation off disconnects every live server and refuses new connections. The class declares `inject: ['tools']` because a dynamically mounted mcp-client child plugin can only resolve services visible through this context.

## Model Experience

Indirect: connected servers publish `mcp__<serverName>__<tool>` tools into the host tool registry, and the model-facing tool list changes accordingly; this package never constructs model input itself.

#### KV Cache effect

Connecting or disconnecting a server changes the available tool list of later turns; session-initial prompts are unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Connection state lives in memory: every server reads as disconnected after a host restart, and reconnecting is a console action.
- Tool lists are observed at connect time; a never-connected server shows no tools in the detail dialog.
- Register/unregister writes go through the Nacos console admin API (`POST|DELETE /v3/console/ai/mcp`) with the configured console account.

<a id="dev-note"></a>
### Dev Note

The registry surface rejects `limit > 100` (`server limit match`), so the controller fetches one 100-row page and pages locally. The fork emits `null://` URL schemes when the endpoint protocol is unset; the controller normalizes them to `http://`. The wire method names avoid `install`/`remove`, which RemoteNamespaceService reserves.
