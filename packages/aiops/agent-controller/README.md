---
description: "Persistent console-managed AIOps agent registry: dynamic preset lifecycle and the aiopsAgents browser namespace."
kind: "package-reference"
---

# @gac2/dsh-aiops-agent-controller

English | [中文](README.zh.md)

## Summary

Mount the console-managed agent registry for the GAC2 operations console. The package persists agent definitions in a JSON registry file and registers each as a dynamic Agent preset cloned from a hidden deployment template. On first boot it seeds the default 运维智能体 (the unified diagnosis entry that coordinates the inner HPC and system agents); afterwards the file is the only source of truth, so console edits and removals survive restarts. The `aiopsAgents` Remote namespace serves the roster with per-preset session statistics plus create, update, and destroy. The template preset itself never appears in the roster.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-agent-controller` in the Web composition (see `aiops.patch.yml`) beside the preset registry and session persistence. Configuration fields are `storePath` (registry JSON path, default `~/.dsh/storages/aiops-agents.json`), `templatePresetId` (template cloned for registered agents, default `os-agent`), `modelLabel` (card model caption; per-agent override is not supported), `templateWaitMs` (startup deadline for the template preset), and `seedAgentsJson` (JSON-encoded definitions seeded when the registry file does not exist yet). The browser console reads and mutates the roster through `ctx.remote.aiopsAgents`; `ClientSessions.create({ agentPreset })` binds new sessions to any listed preset.

## Model Experience

Indirectly, through the dynamic Agent presets it registers: each created agent's persona prefix replaces the template persona, so the definition's text enters model prompts only when a session actually runs under that preset.

#### KV Cache effect

The package adds no model-visible prefix itself. The composed preset's persona owns the prompt prefix, identical in shape to the deployment's static presets.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Per-agent model override is not supported; every agent follows the deployment default model.
- Session statistics derive from persisted session headers (count and newest creation time); titles and turn-level activity are deferred.
- Removing an agent keeps its historical sessions readable, but resuming a session whose preset was removed fails loudly by design.
- Account-based scope filtering is a browser-local presentation filter, not a server-side authorization boundary.

<a id="dev-note"></a>
### Dev Note

The registry file is the single writer-owned source of truth for dynamic agents, written atomically (sibling temporary file, then rename). Preset registration is a Host-side concern: the namespace persists first, then registers or retires the preset against `agentPresets`, so a failed registration never leaves a persisted definition without a visible diagnostic.
