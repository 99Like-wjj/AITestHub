"""Fixed local text embedding service. It accepts no code, paths, URLs or model choices."""

import hashlib
import hmac
import json
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


MODEL_REVISION = "multilingual-e5-small:761b726dd34fb83930e26aab4e9ac3899aa1fa78:int8"
RERANK_REVISION = "bge-reranker-base:280bcc27a84e0b898c251e06fddb25171bd9b101:int8"
ASSETS = {
    "reranker.onnx": "dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244",
    "reranker-tokenizer.json": "48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c",
    "model.onnx": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
}


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_FIELD")
        result[key] = value
    return result


def serve():
    ort.disable_telemetry_events()
    root = Path("/opt/aitesthub-embedding")
    for name, expected in ASSETS.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError("EMBEDDING_ASSET_DIGEST_MISMATCH")
    token = Path(os.environ["AITESTHUB_EMBEDDING_TOKEN_FILE"]).read_text().strip()
    if len(token) < 32:
        raise RuntimeError("EMBEDDING_TOKEN_INVALID")
    tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(root / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    rerank_tokenizer = Tokenizer.from_file(str(root / "reranker-tokenizer.json"))
    rerank_tokenizer.enable_truncation(max_length=512)
    rerank_tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    rerank_session = ort.InferenceSession(str(root / "reranker.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    rerank_names = {item.name for item in rerank_session.get_inputs()}
    names = {item.name for item in session.get_inputs()}
    if not {"input_ids", "attention_mask"}.issubset(names):
        raise RuntimeError("EMBEDDING_MODEL_INPUT_INVALID")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *_args):
            # No user text, HTTP headers, authorization values or request paths enter logs.
            return

        def reply(self, status, value):
            payload = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                return

        def authenticated(self):
            received = self.headers.get("Authorization", "").encode("utf-8")
            return hmac.compare_digest(received, ("Bearer " + token).encode("utf-8"))

        def do_GET(self):
            if not self.authenticated():
                return self.reply(401, {"code": "UNAUTHENTICATED"})
            if self.path != "/health":
                return self.reply(404, {"code": "NOT_FOUND"})
            return self.reply(200, {"modelRevision": MODEL_REVISION, "rerankRevision":RERANK_REVISION, "dimensions": 384, "ready": True, "offline": True})

        def do_POST(self):
            if not self.authenticated():
                return self.reply(401, {"code": "UNAUTHENTICATED"})
            if self.path not in ("/embed", "/rerank"):
                return self.reply(404, {"code": "NOT_FOUND"})
            try:
                self.connection.settimeout(10)
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 128 * 1024:
                    return self.reply(413, {"code": "INPUT_LIMIT"})
                raw = self.rfile.read(length)
                if len(raw) != length:
                    return self.reply(400, {"code": "INVALID_REQUEST"})
                body = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicates)
                if self.path == "/rerank":
                    if not isinstance(body, dict) or set(body) != {"query", "texts"}:
                        return self.reply(400, {"code": "INVALID_REQUEST"})
                    query, texts = body["query"],body["texts"]
                    if not isinstance(query,str) or not 1<=len(query)<=1000 or "\x00" in query or not isinstance(texts,list) or not 1<=len(texts)<=16 or any(not isinstance(text,str) or len(text)>2000 or "\x00" in text for text in texts):
                        return self.reply(400,{"code":"INVALID_REQUEST"})
                    scores,truncated=[],[]
                    for start in range(0,len(texts),2):
                        encoded=rerank_tokenizer.encode_batch([(query,text) for text in texts[start:start+2]])
                        inputs={"input_ids":np.asarray([item.ids for item in encoded],dtype=np.int64),"attention_mask":np.asarray([item.attention_mask for item in encoded],dtype=np.int64)}
                        if "token_type_ids" in rerank_names:inputs["token_type_ids"]=np.asarray([item.type_ids for item in encoded],dtype=np.int64)
                        values=rerank_session.run(None,inputs)[0].reshape(-1)
                        if len(values)!=len(encoded) or not np.isfinite(values).all():raise RuntimeError("RERANK_OUTPUT_INVALID")
                        scores.extend(float(value) for value in values);truncated.extend(bool(item.overflowing) for item in encoded)
                    return self.reply(200,{"modelRevision":RERANK_REVISION,"scores":scores,"tokenTruncated":truncated})
                if not isinstance(body, dict) or set(body) != {"texts", "kind"}:
                    return self.reply(400, {"code": "INVALID_REQUEST"})
                texts, kind = body["texts"], body["kind"]
                if kind not in ("query", "passage") or not isinstance(texts, list) or not 1 <= len(texts) <= 16:
                    return self.reply(400, {"code": "INVALID_REQUEST"})
                if any(not isinstance(text, str) or len(text) > 2000 or "\x00" in text for text in texts):
                    return self.reply(400, {"code": "INVALID_REQUEST"})
                vectors, truncated = [], []
                # Four sequences per inference bound activation memory independently of HTTP batching.
                for start in range(0, len(texts), 4):
                    encoded = tokenizer.encode_batch([kind + ": " + text for text in texts[start:start + 4]])
                    inputs = {
                        "input_ids": np.asarray([item.ids for item in encoded], dtype=np.int64),
                        "attention_mask": np.asarray([item.attention_mask for item in encoded], dtype=np.int64),
                    }
                    if "token_type_ids" in names:
                        inputs["token_type_ids"] = np.asarray([item.type_ids for item in encoded], dtype=np.int64)
                    hidden = session.run(None, inputs)[0]
                    mask = inputs["attention_mask"][:, :, None].astype(np.float32)
                    pooled = (hidden * mask).sum(axis=1) / mask.sum(axis=1)
                    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
                    if pooled.shape[1] != 384 or not np.isfinite(pooled).all() or (norms <= 0).any():
                        raise RuntimeError("EMBEDDING_OUTPUT_INVALID")
                    vectors.extend((pooled / norms).astype(float).tolist())
                    truncated.extend(bool(item.overflowing) for item in encoded)
                return self.reply(200, {"modelRevision": MODEL_REVISION, "vectors": vectors, "tokenTruncated": truncated})
            except (ValueError, UnicodeError, TimeoutError):
                return self.reply(400, {"code": "INVALID_REQUEST"})
            except Exception:
                return self.reply(503, {"code": "EMBEDDING_UNAVAILABLE"})

    host = os.environ.get("AITESTHUB_EMBEDDING_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("AITESTHUB_EMBEDDING_PORT", "5316"))
    server = HTTPServer((host, port), Handler)
    server.timeout = 10
    def stop(_number, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("AITestHub local embedding ready", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        serve()
    except Exception:
        raise SystemExit("EMBEDDING_START_FAILED")
