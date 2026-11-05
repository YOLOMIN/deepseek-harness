---
description: "RAG knowledge-base management for the GAC2 operations console: KBMatrix data-infra proxied behind the aiopsRag namespace — bases, documents, chunks, upload, retrieval test."
kind: "package-reference"
---

# @gac2/dsh-aiops-rag-controller

English | [中文](README.zh.md)

## Summary

Mounts RAG knowledge-base management for the GAC2 operations console. The controller proxies the deployed KBMatrix data-infra API (FastAPI) behind the `aiopsRag` Remote namespace: knowledge-base list/create/delete, paged document listing, document upload (base64 over the wire, rehydrated into multipart host-side) and batch delete, chunk browsing, embedding-model options, and a retrieval test. The platform token is obtained through the web front's `login-local` endpoint, cached in memory, and renegotiated once on authentication failures.

## Table of Contents

- [Use this package](#use-this-package)
- [Model experience](#model-experience)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Development note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-rag-controller` in the Web assembly (see `aiops.patch.yml`). Config fields: `apiOrigin` (required; the data-infra API port, e.g. `http://192.168.32.14:6061`), `authOrigin` (required; the web front issuing tokens, e.g. `http://192.168.32.14:6060`), `username` / `password` (required; the platform account used by login-local), `requestTimeoutMs` (default 15000), `uploadTimeoutMs` (default 120000; parsing large documents is slower). The console reads bases through `ctx.remote.aiopsRag.listBases`, creates/deletes through `createBase` / `deleteBase`, pages documents through `pageDocuments`, uploads through `uploadDocument`, deletes through `deleteDocuments`, browses chunks through `pageChunks`, lists embedding models through `listEmbeddingModels`, and runs the retrieval test through `searchKb`. Retrieval tries `hybrid` first and retries once in `keyword` mode when the vector side yields no hits, so the console still demonstrates recall before the embedding collection warms up.

## Model experience

None directly: this package only serves the console's browser page and constructs no model input. The recall injection switch shown on the page is a presentation of the diagnosis chain's behavior, owned by the ops-agent persona and the memory controller.

#### KV cache effect

None; no session content is read or written.

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- The platform token lives in memory: after a host restart the first call re-logs in; no persistence or multi-user isolation exists (the configured platform account serves every console user).
- Uploads travel base64 over the wire and are capped at 20 MB by the page; very large documents should be uploaded in the KBMatrix web front instead.
- The platform's paged envelopes are read tolerantly (missing members default), so platform schema drift degrades display fields rather than failing the page.

<a id="dev-note"></a>
### Development note

`kb-base/create` answers with the new id as a bare `data` string (not an object); the controller accepts both shapes. `kb-search/search` returns hits with untyped payloads; `mapHit` reads candidate keys tolerantly. Wire method names avoid the RemoteNamespaceService-reserved `remove`/`install`/`has`.
