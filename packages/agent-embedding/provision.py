"""Build-time fixed public model provisioning, never called by the runtime service."""

import hashlib
import pathlib
import urllib.request
import time

ROOT = pathlib.Path("/opt/aitesthub-embedding")
ROOT.mkdir(parents=True, exist_ok=True)
COMMIT = "761b726dd34fb83930e26aab4e9ac3899aa1fa78"
FILES = [
    ("https://huggingface.co/Xenova/bge-reranker-base/resolve/280bcc27a84e0b898c251e06fddb25171bd9b101/onnx/model_quantized.onnx", "reranker.onnx", "dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244"),
    ("https://huggingface.co/Xenova/bge-reranker-base/resolve/280bcc27a84e0b898c251e06fddb25171bd9b101/tokenizer.json", "reranker-tokenizer.json", "48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c"),
    (f"https://huggingface.co/Xenova/multilingual-e5-small/resolve/{COMMIT}/onnx/model_quantized.onnx", "model.onnx", "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193"),
    (f"https://huggingface.co/Xenova/multilingual-e5-small/resolve/{COMMIT}/tokenizer.json", "tokenizer.json", "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
    ("https://raw.githubusercontent.com/microsoft/unilm/master/LICENSE", "MODEL_LICENSE.txt", "904dc4d8749877f1dba1cda48200d2462dccbeb7c134d5e4ef6fa75e0198c8fe"),
    ("https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/LICENSE", "RERANKER_LICENSE.txt", "587a673933425dbc36ec61268d3b954051b2d3ef3c9b322ede357976055ffdd5"),
]
for url, name, expected in FILES:
    target=ROOT/name
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest()!=expected:
            raise RuntimeError("EMBEDDING_EXISTING_ASSET_DIGEST_MISMATCH")
        continue
    partial=ROOT/(name+".partial")
    deadline=time.monotonic()+600
    for attempt in range(8):
        offset=partial.stat().st_size if partial.exists() else 0
        if offset>320*1024*1024:raise RuntimeError("EMBEDDING_ASSET_LIMIT")
        try:
            request=urllib.request.Request(url,headers={"Accept-Encoding":"identity",**({"Range":f"bytes={offset}-"} if offset else {})})
            with urllib.request.urlopen(request,timeout=30) as response:
                if offset and (response.status!=206 or not response.headers.get("Content-Range","").startswith(f"bytes {offset}-")):
                    raise RuntimeError("EMBEDDING_ASSET_RANGE_INVALID")
                with partial.open('ab') as output:
                    while True:
                        data=response.read(1024*1024)
                        if not data:break
                        offset+=len(data)
                        if offset>320*1024*1024:raise RuntimeError("EMBEDDING_ASSET_LIMIT")
                        output.write(data)
            if hashlib.sha256(partial.read_bytes()).hexdigest()==expected:break
        except (OSError,TimeoutError):
            if time.monotonic()>=deadline:break
    if not partial.exists() or hashlib.sha256(partial.read_bytes()).hexdigest()!=expected:
        raise RuntimeError("EMBEDDING_ASSET_DIGEST_MISMATCH")
    partial.replace(target)
(ROOT / "MODEL_NOTICE.txt").write_text(
    "AITestHub uses unchanged quantized ONNX weights from Xenova/multilingual-e5-small, "
    f"revision {COMMIT}. The original model is intfloat/multilingual-e5-small (MIT), "
    "revision 614241f622f53c4eeff9890bdc4f31cfecc418b3. See the upstream model cards "
    "and retained Microsoft MIT license. Relevance reranking uses Xenova/bge-reranker-base "
    "revision 280bcc27a84e0b898c251e06fddb25171bd9b101, original BAAI/bge-reranker-base (MIT); "
    "its unchanged upstream license is RERANKER_LICENSE.txt. Both tokenizer/model hashes are checked at build and startup.\n",
    encoding="utf-8",
)
