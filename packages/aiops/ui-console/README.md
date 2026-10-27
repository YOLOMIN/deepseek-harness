---
description: "GAC2 operations console Web plugin with agent, RAG, skills, logs, memory, and MCP management tabs."
kind: "package-reference"
---

# @gac2/dsh-client-ui-aiops

English | [中文](README.zh.md)

## Summary

Add the operations console to the DSH Web sidebar and main panel. The console contains six management tabs for agents, RAG, skills, logs, memory, and MCP, follows the active theme, and enters Sessions through the existing account and Session surfaces.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-client-ui-aiops` through `aiops.patch.yml`. The plugin contributes the sidebar entry, console panel, localized dictionaries, and account-aware example views. Its Agent card opens a new Session through the existing Workspace browser and associates it with the OS agent.

## Model Experience

The console does not add model-visible content. OS agent identity and tool composition are supplied by `aiops.patch.yml` or `aiops-headless.patch.yml`; this package contributes no prompt or tool behavior.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Console resource lists and counts are prototype data until the platform services expose them.
- Most management actions are presentation placeholders; durable operations require their owning RAG, Skill, log, memory, and MCP services.
- Account filtering is browser-local for the current integration and is not a server-side authorization boundary.

<a id="dev-note"></a>
### Dev Note

The package is private to the GAC2 deployment and is mounted by the repository-owned `aiops.patch.yml`.
