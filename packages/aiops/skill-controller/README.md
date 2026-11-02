---
description: "Skill management for the GAC2 operations console: Nacos skill-registry listing merged with local install state, zip install/uninstall over the aiopsSkills namespace."
kind: "package-reference"
---

# @gac2/dsh-aiops-skill-controller

English | [中文](README.zh.md)

## Summary

Mount skill management for the GAC2 operations console. The controller lists skills from the deployment's Nacos registry well-known discovery surface (`/registry/{namespace}/.well-known/agent-skills/index.json`), merges each row with the local install state under the DSH user skills root, and installs (per-file download) or uninstalls (remove the directory) through the `aiopsSkills` Remote namespace. The skill-filesystem provider watches the root, so installs take effect without a restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-skill-controller` in the Web composition (see `aiops.patch.yml`). Configuration fields: `registryOrigin` (required, e.g. `http://192.168.10.95:9080`), `namespaceId` (default `public`), `skillsDir` (default `~/.dsh/skills`), `requestTimeoutMs` (default 15000). The console queries through `ctx.remote.aiopsSkills.list({ keyword, page, pageSize })`, reads one skill through `detail`, and installs/uninstalls by skill name. The registry dialog and the discovery/invocation switches read/write through `getSettings`/`saveSettings`; overrides persist in `aiops-skill-registry.json` beside the skills root, take precedence over the plugin config, and apply on save. With discovery off the listing shows only locally installed skills; with invocation off every installed skill moves into the sibling `skills-quarantine` directory, invisible to agents, and moves back when re-enabled.

## Model Experience

None, as the package only serves console management views and never constructs model input; installed skills reach the model through the skill-filesystem provider and `tool-skill`, which own their model-visible effects.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Registry listing fetches up to 200 rows and pages locally; server-side paging is deferred until registry volumes justify it.
- Upload/publish lifecycle (`/upload`, review, release) stays in the Nacos console; the DSH console only consumes and installs.

<a id="dev-note"></a>
### Dev Note

Registry responses are unwrapped from the Nacos `Result` envelope and validated at the Remote boundary; install fetches each declared file from the well-known surface into a clean directory, and uninstall only removes the local directory — registry entries are never deleted from this path.
