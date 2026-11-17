# SPDX-License-Identifier: MIT
"""SearXNG engine for Bing's public RSS response; no credentials or import I/O."""

from urllib.parse import urlencode, urlsplit
from xml.etree import ElementTree


about = {
    "website": "https://www.bing.com",
    "use_official_api": False,
    "require_api_key": False,
    "results": "RSS",
}
categories = ["general", "web"]
paging = False
language_support = False
safesearch = False
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_RESULTS = 20


def request(query, params):
    """Only the trusted, fixed public provider origin receives the query."""
    params["url"] = "https://www.bing.com/search?" + urlencode(
        {"format": "rss", "q": query}
    )
    params["method"] = "GET"
    params["allow_redirects"] = True
    params["max_redirects"] = 2
    params["soft_max_redirects"] = 2
    params["headers"]["Accept"] = "application/rss+xml, application/xml;q=0.9"
    params["headers"]["User-Agent"] = "Mozilla/5.0"
    return params


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def child_text(item, name):
    for child in item:
        if local_name(child.tag) == name:
            return "".join(child.itertext()).strip()
    return ""


def response(resp):
    """Parse bounded bytes so XML encoding declarations remain valid."""
    if resp.status_code >= 400:
        resp.raise_for_status()
    raw = resp.content
    if not isinstance(raw, bytes) or len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("RSS_RESPONSE_LIMIT")
    if b"\x00" in raw:
        raise ValueError("RSS_RESPONSE_ENCODING")
    lowered = raw.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise ValueError("RSS_DOCUMENT_TYPE_NOT_ALLOWED")
    root = ElementTree.fromstring(raw)
    if local_name(root.tag) != "rss":
        raise ValueError("RSS_RESPONSE_FORMAT")
    results = []
    seen = set()
    for item in root.iter():
        if local_name(item.tag) != "item":
            continue
        url = child_text(item, "link")
        title = child_text(item, "title")
        if not title or len(url) > 2000 or any(ord(c) <= 32 for c in url):
            continue
        try:
            parsed = urlsplit(url)
            parsed.port
        except ValueError:
            continue
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or url in seen
        ):
            continue
        seen.add(url)
        results.append(
            {
                "url": url,
                "title": title[:500],
                "content": child_text(item, "description")[:2000],
            }
        )
        if len(results) >= MAX_RESULTS:
            break
    return results
