# PDF and Office document input

`AgentDocumentsService` loads only files permitted by the existing file service. Internal AI reads also require the trusted task's `authorizeResource` callback. The callback and file access are checked again after parsing; parsed-content caching never caches permission.

`SandboxDocumentParser` runs a fixed parser through the independent sandbox broker. Its immutable execution image must contain the dependencies in `deploy/local/requirements.documents.txt`. Build `deploy/local/Dockerfile.documents` from the repository root and configure its exact image ID in the sandbox broker. The default wheel hashes cover Linux amd64 and CPython 3.13. Other platforms need separately reviewed wheel hashes, not an unpinned installer fallback.

The document image includes pypdfium2 under BSD-3-Clause/Apache-2.0 and Pillow under MIT-CMU. Their installed wheels retain the PDFium and codec dependency license notices. No third-party document parser source is copied into the platform repository.

PDF pages have actual rendered image inputs, including pages without an extractable text layer. Office input uses package structure, cells, formula/cache distinctions, embedded images and chart caches. It does not execute macros, formulas, linked resources or embedded programs, and does not claim exact Word pagination or complete Office visual rendering.

Reads are bounded and expose `nextOffset`. PDF offsets identify pages; Office offsets identify structural units, with an optional worksheet name or slide section. `partial` may also indicate visual or external-content limitations after all structural units have been read. A null cursor therefore means the selected structural range ended, not that every visual feature was rendered.

The parser keeps at most 16 results and 32 MiB in process memory for two minutes. Cache identity includes source SHA, media type and query. Concurrent identical parsing is shared; cancelling one waiter does not cancel another, while cancelling all waiters aborts the underlying sandbox. Each caller receives a copy and must still pass current source authorization before and after every read.
