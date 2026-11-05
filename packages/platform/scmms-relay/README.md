---
description: "SCMMS platform integration relay: console entry, ticket pass-through, Copilot streaming diagnosis, human-in-the-loop permission answers, and the solution push closed loop."
kind: "package-reference"
---

# @gac2/dsh-scmms-relay

English | [中文](README.zh.md)

## Summary

The **standalone plugin** for SCMMS platform integration (split out of the aiops console code on 2026-11-05, formerly `@gac2/dsh-aiops-auth-relay`), so any team can integrate the platform without the operations console. Mounted on an isolated DSH `webServer` (default `127.0.0.1:3081`), it provides:

- console entry (injects the dsh access token, passes through the platform's one-time ticket and target tab);
- platform health check (`/health` forwarding `/api/aiops/health`);
- the Copilot SSE diagnosis channel (a persistent ACP child `dsh --profile acp`; every browser conversation is a standard ACP session);
- operation-level human confirmation (with `permission: ask`, permission prompts are held and forwarded as SSE events, answered through `POST /api/aiops/permission`) and the solution push closed loop (on completion, the plan with its `exec_actions` block is pushed to the platform `/api/aiops/solutions`).

Platform account integration consumes the platform's standard `/api/aiops/*` endpoints; the platform-side companion code (solution closed-loop in Go and the Copilot frontend component) lives in `platform/scmms/` at the repository root.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount with the root `platform.patch.yml` (standalone); when co-deployed with the console, add `aiops.patch.yml`: `pnpm dsh --profile web --patch platform.patch.yml [--patch aiops.patch.yml]`.

Configuration fields: `platformOrigin` (required, e.g. `http://192.168.10.95:9091`), `dshRoot`, `sessionCwd`, `consoleTarget`, `acpPatchPath`, `permission` (`allow`/`reject`/`ask`; `ask` turns prompts into human-confirmation events), `sandboxMode` (injected as the child's `DSH_PERMISSION_MODE`; `read-only` makes writes require human approval), `platformBearerToken` (solution push bearer; empty disables), `solutionPushTimeoutMs`, `requestTimeoutMs`. The redirect token comes from the co-process `connection` service, and the model credential resolves through `ctx.credentials`; platform secrets never enter ordinary settings.

## Model Experience

Indirect, through the persistent `acp` profile child carrying Copilot sessions: standard ACP message, thought, and tool lifecycle updates are translated into SSE events; the model context is owned by the acp profile and its persona patch.

#### KV Cache effect

The plugin adds no model-visible prefix. The model context is owned by the acp profile and its persona patch.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Permission events carry the tool name and reason (not full arguments); forwarding `rawInput` waits on the upstream ACP bridge.
- Sandbox escalation is per session: after the first approval of a session, same-mode writes no longer prompt (stock DSH sandbox semantics).

<a id="dev-note"></a>
### Dev Note

`platform.patch.yml` owns the isolated listener and deployment paths. The previous external `relay/aiops-auth-relay.js` script is replaced by this package; platform authentication adapter duties (SM3/SM4 login, ticket issuance and redemption) have moved down into the operations platform as standard endpoints.
