# Public search deployment

The workbench consumes the configured SearXNG JSON endpoint. Search results are
untrusted source material; their links remain subject to the normal public HTTP
and browser network policies.

Some networks cannot reach the default engines. The optional
`deploy/local/compose.search-rss.yaml` overlay adds the project-owned
`ath_bing_rss` engine without changing the pinned SearXNG image. Enable it in the
external, restricted settings file:

```yaml
engines:
  - name: bing rss
    engine: ath_bing_rss
    categories: [general, web]
    shortcut: bingrss
    disabled: false
    timeout: 12
```

The adapter reads Bing's public RSS response as bounded XML bytes. This preserves
encoding declarations that the generic HTML XPath engine cannot parse. It rejects
document types, entities, credential-bearing links, unsupported URL schemes and
oversized responses. Query text cannot select another provider origin. Upstream
failures remain failures; the adapter does not invent search results or bypass
authentication or challenges. This configuration does not enable external MCP or
grant access to platform or private-network origins.
