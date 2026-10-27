---
description: "Cordis routes for GAC2 console entry, ticket pass-through, platform health checks, and headless Copilot."
kind: "package-reference"
---

# @gac2/dsh-aiops-auth-relay

English | [中文](README.zh.md)

## Summary

Mount the GAC2 operations integration on an isolated DSH `webServer`. It provides console redirects (injecting the dsh launch token and passing through the platform-issued sign-in ticket), platform health checks, and headless Copilot forwarding without a separate relay process.

Platform account integration does not pass through this plugin: the operations platform exposes the authentication adapter protocol as standard endpoints (`POST /api/aiops/login` for password authentication, `POST /api/aiops/ticket` for ticket issuance, `POST /api/aiops/ticket-login` for ticket redemption, `GET /api/aiops/health` for health checks). The console's "operations platforms" settings point directly at those platform endpoints, so swapping the console implementation keeps the integration protocol unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-auth-relay` beside `@deepseek-ai/dsh-host-webserver` in a Cordis group that isolates `webServer`. `aiops.patch.yml` uses `127.0.0.1:3081`; the primary Web application continues on `3080`.

Configuration fields are `platformOrigin`, `dshRoot`, `sessionCwd`, `consoleLogPath`, and `requestTimeoutMs`. Defaults target the current GAC2 platform and checkout. The plugin reads model credentials through `ctx.credentials`; platform passwords, cookies, and MCP tokens do not enter ordinary settings.

## Model Experience

Copilot forwards user messages to the normal `headless` profile with `aiops-headless.patch.yml`. NDJSON `session`, text, thinking, tool, status, final, and error events become SSE events. Each request launches a child process, and disposal or client disconnect stops it.

#### KV Cache effect

The plugin adds no model-visible prefix. Model context is owned by the normal headless profile and its persona.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The console redirect reads the current launch token from the configured DSH startup log. Rotating that log requires restarting DSH before console entry works again.
- MCP tool registration into agent presets is configured separately from these integration routes.

<a id="dev-note"></a>
### Dev Note

`aiops.patch.yml` owns the isolated listener and deployment paths. The previous external `relay/aiops-auth-relay.js` script is replaced by this package. The platform authentication adapter duties this package once carried (SM3/SM4 login, ticket issuance and redemption) have been moved down into the operations platform as standard endpoints served by the platform itself.
