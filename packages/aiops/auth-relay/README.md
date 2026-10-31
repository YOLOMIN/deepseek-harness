---
description: "Cordis routes for GAC2 console entry, ticket pass-through, platform health checks, and the ACP Copilot channel."
kind: "package-reference"
---

# @gac2/dsh-aiops-auth-relay

English | [中文](README.zh.md)

## Summary

Mount the GAC2 operations integration on an isolated DSH `webServer`: console redirects (injecting the dsh launch token, passing through platform sign-in tickets), platform health checks, and the Copilot SSE channel without a separate relay process. Copilot prompts run on one persistent ACP child (`dsh --profile acp`): each browser conversation is a standard ACP session, follow-ups skip the cold start, disconnects become `session/cancel`, and a child crash respawns on the next prompt. Platform account integration uses the operations platform's standard `/api/aiops/*` endpoints directly, not this plugin, so swapping the console keeps the protocol unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-auth-relay` beside `@deepseek-ai/dsh-host-webserver` in a Cordis group that isolates `webServer`. `aiops.patch.yml` uses `127.0.0.1:3081`; the primary Web application continues on `3080`.

Configuration fields are `platformOrigin` (required per deployment), `dshRoot`, `sessionCwd`, `consoleTarget`, `acpPatchPath`, `permission` (auto-answer policy for the agent's tool-permission prompts), and `requestTimeoutMs`, all set by the mounting patch such as `aiops.patch.yml`. The redirect token comes from the in-process `connection` service, and model credentials are read through `ctx.credentials`; platform passwords, cookies, and MCP tokens do not enter ordinary settings.

## Model Experience

Indirectly, through the persistent `acp` profile child driving Copilot sessions: standard ACP message, thought, and tool-lifecycle updates become SSE events, while model context stays owned by the acp profile and its persona patch.

#### KV Cache effect

The plugin adds no model-visible prefix. Model context is owned by the acp profile and its persona patch.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- MCP tool registration into agent presets is configured separately from these integration routes.

<a id="dev-note"></a>
### Dev Note

`aiops.patch.yml` owns the isolated listener and deployment paths. The previous external `relay/aiops-auth-relay.js` script is replaced by this package. The platform authentication adapter duties this package once carried (SM3/SM4 login, ticket issuance and redemption) have been moved down into the operations platform as standard endpoints served by the platform itself.
