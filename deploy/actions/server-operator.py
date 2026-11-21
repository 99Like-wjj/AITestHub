#!/usr/bin/env python3
"""Trusted, installed host operator for qualified code-only application releases.

No remote code, migration, database restore, business replay or proxy update is
accepted. Install this reviewed file separately from the candidate application.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class Rejected(Exception):
    """An intentionally non-sensitive public error code."""


def require(condition, code):
    if not condition:
        raise Rejected(code)


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def decode_json(data):
    try:
        return json.loads(data, object_pairs_hook=pairs)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Rejected("INVALID_JSON") from error


def keys(value, required, optional=()):
    require(isinstance(value, dict), "OBJECT_REQUIRED")
    require(set(required) <= set(value) <= set(required) | set(optional), "INVALID_FIELDS")


def match(value, expression, code):
    require(isinstance(value, str) and re.fullmatch(expression, value), code)
    return value


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_config_id(archive, source_commit):
    """Read archive metadata only; never extract an untrusted tar path."""
    with tarfile.open(archive, "r") as image:
        members = {item.name: item for item in image.getmembers()}
        require(len(members) <= 100000, "IMAGE_ARCHIVE_LIMIT")

        def raw(name):
            require(name in members, "IMAGE_ARCHIVE_ENTRY_MISSING")
            entry = members[name]
            require(entry.isfile() and entry.size <= 16 * 1024 * 1024, "IMAGE_ARCHIVE_METADATA_REJECTED")
            stream = image.extractfile(entry)
            require(stream is not None, "IMAGE_ARCHIVE_ENTRY_MISSING")
            return stream.read()

        def descriptor(value):
            keys(value, ["digest", "mediaType", "size"], ["annotations", "platform", "artifactType", "urls", "data"])
            digest = match(value["digest"], r"sha256:[a-f0-9]{64}", "IMAGE_ARCHIVE_DIGEST_REJECTED")
            data = raw("blobs/sha256/" + digest[7:])
            require(len(data) == value["size"] and sha_bytes(data) == digest[7:], "IMAGE_ARCHIVE_BLOB_MISMATCH")
            return data

        configurations = []
        if "manifest.json" in members:
            manifests = decode_json(raw("manifest.json"))
            require(isinstance(manifests, list) and 1 <= len(manifests) <= 100, "IMAGE_ARCHIVE_MANIFEST_REJECTED")
            for manifest in manifests:
                name = manifest.get("Config")
                match(name, r"(?:blobs/sha256/)?[a-f0-9]{64}(?:\.json)?", "IMAGE_ARCHIVE_CONFIG_PATH_REJECTED")
                configurations.append(raw(name))
        else:
            index = decode_json(raw("index.json"))

            def visit(value, depth=0):
                require(depth <= 5, "IMAGE_ARCHIVE_INDEX_DEPTH")
                if "manifests" in value:
                    require(isinstance(value["manifests"], list) and len(value["manifests"]) <= 100, "IMAGE_ARCHIVE_INDEX_REJECTED")
                    for child in value["manifests"]:
                        platform = child.get("platform", {})
                        if platform and (platform.get("os") != "linux" or platform.get("architecture") != "amd64"):
                            continue
                        visit(decode_json(descriptor(child)), depth + 1)
                elif "config" in value:
                    configurations.append(descriptor(value["config"]))
                else:
                    raise Rejected("IMAGE_ARCHIVE_MANIFEST_REJECTED")

            visit(index)
        matches = set()
        for data in configurations:
            value = decode_json(data)
            if value.get("os") == "linux" and value.get("architecture") == "amd64" and value.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") == source_commit:
                matches.add("sha256:" + sha_bytes(data))
        require(len(matches) == 1, "IMAGE_ARCHIVE_CONFIG_AMBIGUOUS")
        return next(iter(matches))


def safe_path(value):
    require(isinstance(value, str) and len(value) <= 4096, "INVALID_PATH")
    path = Path(value)
    require(path.is_absolute() and str(path) == str(PurePosixPath(value)), "ABSOLUTE_PATH_REQUIRED")
    require(".." not in path.parts and not any(c in value for c in "\n\r\x00"), "UNSAFE_PATH")
    return path


def ordinary(path, directory=False):
    require(path.resolve() == path, "LINKED_PATH_REJECTED")
    item = path.lstat()
    require(not stat.S_ISLNK(item.st_mode), "LINKED_PATH_REJECTED")
    require(stat.S_ISDIR(item.st_mode) if directory else stat.S_ISREG(item.st_mode), "PATH_TYPE_REJECTED")
    return item


def trusted(path, directory=False, private=False):
    item = ordinary(path, directory)
    require(item.st_uid == 0 and item.st_mode & 0o022 == 0, "ROOT_OWNED_PATH_REQUIRED")
    if private:
        require(item.st_mode & 0o077 == 0, "PRIVATE_PATH_REQUIRED")
    return item


def release_parent(path, ops_user):
    import pwd
    item = ordinary(path, True)
    allowed = [0, pwd.getpwnam(ops_user).pw_uid]
    require(item.st_uid in allowed and item.st_mode & 0o022 == 0, "RELEASE_PARENT_OWNERSHIP_REJECTED")
    return item


def validate_release(release):
    keys(release, ["schemaVersion", "repository", "sourceCommit", "runId", "runAttempt", "imageRef", "imageId", "nodeSha256", "files", "migrations"])
    require(release["schemaVersion"] == "ath.actions-release.v1", "RELEASE_VERSION_REJECTED")
    match(release["repository"], r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", "REPOSITORY_REJECTED")
    match(release["sourceCommit"], r"[a-f0-9]{40}", "SOURCE_COMMIT_REJECTED")
    match(release["runId"], r"[1-9][0-9]{0,19}", "RUN_ID_REJECTED")
    match(release["runAttempt"], r"[1-9][0-9]{0,9}", "RUN_ID_REJECTED")
    image = r"ghcr\.io/" + re.escape(release["repository"].lower()) + r"@sha256:[a-f0-9]{64}"
    match(release["imageRef"], image, "IMAGE_REFERENCE_REJECTED")
    match(release["imageId"], r"sha256:[a-f0-9]{64}", "IMAGE_ID_REJECTED")
    match(release["nodeSha256"], r"[a-f0-9]{64}", "NODE_DIGEST_REJECTED")
    require(isinstance(release["files"], dict) and 8 <= len(release["files"]) <= 10000, "RUNTIME_FILES_REJECTED")
    for name, digest in release["files"].items():
        match(name, r"[A-Za-z0-9_./@+-]{1,512}", "RUNTIME_PATH_REJECTED")
        path = PurePosixPath(name)
        require(not path.is_absolute() and ".." not in path.parts and str(path) == name, "RUNTIME_PATH_REJECTED")
        require(all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", segment) for segment in path.parts), "RUNTIME_PATH_REJECTED")
        require(name == "package.json" or name.startswith(("dist/", "apps/web/dist/", "packages/persistence/migrations/")), "RUNTIME_PATH_REJECTED")
        match(digest, r"[a-f0-9]{64}", "RUNTIME_DIGEST_REJECTED")
    require(isinstance(release["migrations"], dict) and 1 <= len(release["migrations"]) <= 1000, "MIGRATIONS_REJECTED")
    for name, digest in release["migrations"].items():
        match(name, r"[0-9]{4}_[a-z][a-z0-9_]*\.sql", "MIGRATION_NAME_REJECTED")
        match(digest, r"[a-f0-9]{64}", "MIGRATION_DIGEST_REJECTED")
    from_files = {name.removeprefix("packages/persistence/migrations/"): digest for name, digest in release["files"].items() if name.startswith("packages/persistence/migrations/")}
    require(from_files == release["migrations"], "MIGRATIONS_PROOF_MISMATCH")
    require(sorted(int(name[:4]) for name in release["migrations"]) == list(range(1, len(release["migrations"]) + 1)), "MIGRATION_SEQUENCE_REJECTED")
    for name in ["package.json", "dist/apps/api/src/main.js", "dist/apps/api-worker/src/main.js", "dist/apps/ai-worker/src/main.js", "apps/web/dist/index.html", "dist/scripts/operations-worker.js", "dist/packages/application/src/recovery/crypto.js"]:
        require(name in release["files"], "REQUIRED_RUNTIME_FILE_MISSING")
    return release


def read_request(data):
    require(0 < len(data) <= 4 * 1024 * 1024, "REQUEST_SIZE_REJECTED")
    value = decode_json(data)
    keys(value, ["action", "operationId"], ["release", "releaseBytes", "qualification", "registryToken"])
    require(value["action"] in ["plan", "deploy", "status", "qualify"], "ACTION_REJECTED")
    try:
        require(str(uuid.UUID(value["operationId"])) == value["operationId"], "OPERATION_ID_REJECTED")
    except (ValueError, TypeError, AttributeError) as error:
        raise Rejected("OPERATION_ID_REJECTED") from error
    if value["action"] == "status":
        require(set(value) == {"action", "operationId"}, "STATUS_FIELDS_REJECTED")
        return value
    require("release" in value and "releaseBytes" in value, "RELEASE_REQUIRED")
    validate_release(value["release"])
    try:
        raw = base64.b64decode(value["releaseBytes"], validate=True)
    except (ValueError, TypeError) as error:
        raise Rejected("RELEASE_ENCODING_REJECTED") from error
    require(len(raw) <= 3 * 1024 * 1024 and decode_json(raw) == value["release"], "RELEASE_BYTES_MISMATCH")
    value["releaseSha256"] = sha_bytes(raw)
    if "registryToken" in value:
        require(value["action"] == "deploy", "TOKEN_NOT_ACCEPTED_FOR_ACTION")
        match(value["registryToken"], r"[^\s\x00-\x1f]{1,8192}", "REGISTRY_TOKEN_REJECTED")
    return value


SNAPSHOT = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDatabaseFromEnvironment} from './dist/packages/persistence/src/config.js';
import {ControlJournal} from './dist/packages/application/src/recovery/control-journal.js';
import {assertModelProtocolCheckpoint} from './dist/packages/application/src/configuration/model-checkpoint.js';
import {MaintenanceService} from './dist/packages/application/src/recovery/maintenance.js';
const db=await createDatabaseFromEnvironment();
try {
  const controls=await ControlJournal.fromEnvironment(db);
  await controls.assertCurrentSource();
  await assertModelProtocolCheckpoint(db,controls);
  assert.equal((await db.query('SELECT platform_id FROM app.recovery_control_state WHERE singleton')).rows[0].platform_id,cfg.platformId);
  const migrations=(await db.query('SELECT version,checksum FROM app.schema_migrations ORDER BY version')).rows;
  assert.deepEqual(Object.fromEntries(migrations.map(r=>[r.version,r.checksum])),cfg.migrations);
  const models={};
  for(const table of ['model_services','model_service_revisions','model_entries','model_entry_verifications','auxiliary_model_configuration'])
    models[table]=(await db.query('SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) rows FROM app.'+table+' t')).rows[0].rows;
  const counts=(await db.query("SELECT (SELECT count(*) FROM app.ai_tasks WHERE state IN ('accepted','running','cancelling'))::int ai,(SELECT count(*) FROM app.auxiliary_tasks WHERE state IN ('accepted','running','cancelling'))::int auxiliary,(SELECT count(*) FROM app.model_call_ledger WHERE status='dispatchIntent')::int dispatch,(SELECT count(*) FROM app.product_backups WHERE state IN ('queued','preparing'))::int backups,(SELECT count(*) FROM app.api_worker_grants g JOIN app.runs r ON r.id=g.run_id WHERE g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND r.state IN ('prepared','running','stopping'))::int runs,(SELECT count(*) FROM app.model_call_ledger)::int ledger")).rows[0];
  const maintenance=new MaintenanceService(db);
  console.log(JSON.stringify({migrations,modelDigest:createHash('sha256').update(JSON.stringify(models)).digest('hex'),counts,maintenance:await maintenance.status(),active:await maintenance.activeWork()}));
} finally {await db.close();}
"""

MAINTENANCE = r"""
import assert from 'node:assert/strict';
import {createDatabaseFromEnvironment} from './dist/packages/persistence/src/config.js';
import {ControlJournal} from './dist/packages/application/src/recovery/control-journal.js';
import {MaintenanceService} from './dist/packages/application/src/recovery/maintenance.js';
const db=await createDatabaseFromEnvironment();
try {
  const controls=await ControlJournal.fromEnvironment(db); await controls.initialize(); await controls.assertCurrentSource();
  const service=new MaintenanceService(db,()=>controls.assertCurrentSource());
  if(cfg.action==='enter') {await service.begin(cfg.operationId,'CODE_ONLY_ACTIONS_RELEASE');await service.waitUntilDrained(cfg.operationId,30000);}
  else {const current=await service.status();if(current.operation_id===cfg.operationId)await service.release(cfg.operationId);else assert.equal(current.phase,'idle');}
  console.log(JSON.stringify({maintenance:await service.status(),active:await service.activeWork()}));
} finally {await db.close();}
"""

BACKUP_REQUEST = r"""
import {createDatabaseFromEnvironment} from './dist/packages/persistence/src/config.js';
import {BackupJobService} from './dist/packages/application/src/recovery/jobs.js';
const db=await createDatabaseFromEnvironment();
try {const receipt=await new BackupJobService(db).requestInternal('upgrade');console.log(JSON.stringify({backupId:receipt.id}));}
finally {await db.close();}
"""

BACKUP_STATUS = r"""
import {createDatabaseFromEnvironment} from './dist/packages/persistence/src/config.js';
const db=await createDatabaseFromEnvironment();
try {const row=(await db.query('SELECT state FROM app.product_backups WHERE id=$1',[cfg.backupId])).rows[0];console.log(JSON.stringify({state:row?.state??'missing'}));}
finally {await db.close();}
"""

BACKUP_VERIFY = r"""
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {createDatabaseFromEnvironment} from './dist/packages/persistence/src/config.js';
import {BackupFiles} from './dist/packages/application/src/recovery/backup-files.js';
const db=await createDatabaseFromEnvironment();
try {
  assert.equal((await db.query('SELECT state FROM app.product_backups WHERE id=$1',[cfg.backupId])).rows[0]?.state,'complete');
  const key=Buffer.from((await readFile(process.env.AITESTHUB_BACKUP_KEY_FILE,'utf8')).trim(),'hex');
  const files=new BackupFiles(process.env.AITESTHUB_BACKUP_DIRECTORY,key),manifest=await files.read(cfg.backupId);
  await files.verify(manifest);
  assert.deepEqual(Object.fromEntries(manifest.versions.migrations.map(row=>[row.version,row.checksum])),cfg.migrations);
  console.log(JSON.stringify({verified:true}));
} finally {await db.close();}
"""

VERIFY_SIGNATURE = r"""
import {verify,createPublicKey} from 'node:crypto';
const key=createPublicKey(cfg.publicKey);
if(key.asymmetricKeyType!=='ed25519')throw Error('INVALID_KEY_TYPE');
console.log(JSON.stringify({valid:verify(null,Buffer.from(cfg.payload,'base64'),key,Buffer.from(cfg.signature,'base64'))}));
"""


class Operator:
    def __init__(self, configuration, request):
        self.cfg = configuration
        self.request = request
        self.release = request.get("release")
        self.state_root = Path(configuration["stateRoot"])
        self.operation = self.state_root / "operations" / request["operationId"]
        self.runtime = None if request["action"] == "status" else self.active_runtime()
        self.state = {"operationId": request["operationId"], "migrationsRun": 0, "modelRequests": 0}
        if self.release:
            self.state.update({"sourceCommit": self.release["sourceCommit"], "imageId": self.release["imageId"], "releaseSha256": request["releaseSha256"]})

    def run(self, args, timeout=45, data=None, env=None, user=False, cwd=None):
        options = {}
        if user:
            import pwd
            account = pwd.getpwnam(self.cfg["opsUser"])
            options.update(user=account.pw_uid, group=account.pw_gid, extra_groups=os.getgrouplist(account.pw_name, account.pw_gid))
        try:
            result = subprocess.run(args, input=data, capture_output=True, timeout=timeout, env=env or {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, cwd=cwd, **options)
        except (subprocess.TimeoutExpired, OSError) as error:
            raise Rejected("HOST_COMMAND_RESULT_UNKNOWN") from error
        require(result.returncode == 0, "HOST_COMMAND_FAILED")
        require(len(result.stdout) <= 8 * 1024 * 1024, "HOST_OUTPUT_LIMIT")
        return result.stdout.decode("utf-8").strip()

    def docker(self, args, timeout=45, data=None, env=None):
        return self.run(["/usr/bin/docker"] + args, timeout, data, env)

    def system(self, *args):
        return self.run(["/usr/bin/systemctl", *args], 60)

    def active_runtime(self):
        working = self.system("show", self.cfg["opsUnit"], "--property=WorkingDirectory", "--value")
        path = safe_path(working)
        require(path.name == "app" and path.parent.parent == Path(self.cfg["releaseRoot"]), "OPS_RUNTIME_REJECTED")
        trusted(path.parent, True)
        trusted(path, True)
        trusted(path.parent / "node")
        require(self.system("show", self.cfg["opsUnit"], "--property=User", "--value") == self.cfg["opsUser"], "OPS_USER_CHANGED")
        return path.parent

    def node(self, source, values=None, timeout=120, with_env=True):
        cfg = {"platformId": self.cfg["platformId"], "operationId": self.request["operationId"]}
        if self.release:
            cfg["migrations"] = self.release["migrations"]
        cfg.update(values or {})
        prefix = "const cfg=JSON.parse(Buffer.from('" + base64.b64encode(json.dumps(cfg).encode()).decode() + "','base64').toString('utf8'));\n"
        environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "NODE_ENV": "production"}
        if with_env:
            ordinary(Path(self.cfg["opsEnv"]))
            for line in Path(self.cfg["opsEnv"]).read_text().splitlines():
                if not line or line.startswith("#"):
                    continue
                name, separator, value = line.partition("=")
                require(bool(separator) and re.fullmatch(r"[A-Z][A-Z0-9_]*", name), "OPS_ENV_REJECTED")
                require(name not in ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"], "OPS_ENV_REJECTED")
                parsed = shlex.split(value)
                require(len(parsed) == 1, "OPS_ENV_REJECTED")
                environment[name] = parsed[0]
            require(environment.get("AITESTHUB_LOCAL_ROOT") == self.cfg["privateRoot"], "OPS_ROOT_MISMATCH")
            require(environment.get("DB_HOST") in ["127.0.0.1", "localhost"], "LOOPBACK_DATABASE_REQUIRED")
            root = Path(self.cfg["privateRoot"])
            established = [
                Path(environment.get("AITESTHUB_MASTER_KEY_FILE", str(root / "secrets/platform-master-key"))),
                Path(environment.get("AITESTHUB_RECOVERY_CONTROL_KEY_FILE", str(root / "secrets/recovery-control-key"))),
                Path(environment.get("AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE", str(root / "recovery/controls/security-control-anchor.json"))),
                Path(environment.get("AITESTHUB_RECOVERY_CONTROL_DIRECTORY", str(root / "control/security-controls"))) / "head.json",
            ]
            for path in established:
                ordinary(path)
        output = self.run([str(self.runtime / "node"), "--input-type=module", "-"], timeout, (prefix + source).encode(), environment, True, str(self.runtime / "app"))
        return decode_json(output)

    def snapshot(self):
        return self.node(SNAPSHOT)

    def idle(self, snapshot):
        return snapshot["maintenance"]["phase"] == "idle" and snapshot["active"]["total"] == 0 and all(snapshot["counts"][name] == 0 for name in ["ai", "auxiliary", "dispatch", "backups", "runs"])

    def image(self, reference, optional=False):
        try:
            result = decode_json(self.docker(["image", "inspect", reference]))[0]
        except Rejected:
            if optional:
                return None
            raise
        require(result["Os"] == "linux" and result["Architecture"] == "amd64", "CANDIDATE_IMAGE_MISMATCH")
        require(reference in result.get("RepoDigests", []), "IMAGE_REFERENCE_DIGEST_MISMATCH")
        require(result["Config"].get("Labels", {}).get("org.opencontainers.image.revision") == self.release["sourceCommit"], "IMAGE_SOURCE_MISMATCH")
        with tempfile.TemporaryDirectory(prefix="ath-image-proof-") as temporary:
            archive = Path(temporary) / "image.tar"
            self.docker(["image", "save", "--output", str(archive), reference], 180)
            require(canonical_config_id(archive, self.release["sourceCommit"]) == self.release["imageId"], "CANONICAL_IMAGE_CONFIG_MISMATCH")
        self.candidate_daemon_id = result["Id"]
        return result

    def qualification(self, required=False, envelope=None, enforce_age=True):
        envelope = envelope if envelope is not None else self.request.get("qualification")
        if envelope is None:
            path = self.state_root / "qualifications" / (self.request["releaseSha256"] + ".json")
            if path.exists():
                trusted(path, private=True)
                record = decode_json(path.read_bytes())
                keys(record, ["releaseSha256", "qualification"])
                require(record["releaseSha256"] == self.request["releaseSha256"], "QUALIFICATION_RECORD_MISMATCH")
                envelope = record["qualification"]
        if envelope is None:
            require(not required, "LOCAL_QUALIFICATION_REQUIRED")
            return None
        keys(envelope, ["payload", "signature"])
        try:
            payload_bytes = base64.b64decode(envelope["payload"], validate=True)
            signature = base64.b64decode(envelope["signature"], validate=True)
        except (ValueError, TypeError) as error:
            raise Rejected("QUALIFICATION_ENCODING_REJECTED") from error
        require(len(payload_bytes) <= 16384 and len(signature) == 64, "QUALIFICATION_SIZE_REJECTED")
        payload = decode_json(payload_bytes)
        keys(payload, ["schemaVersion", "repository", "sourceCommit", "runId", "runAttempt", "imageRef", "imageId", "releaseSha256", "checkedAt", "evidenceSha256", "checks"])
        require(payload["schemaVersion"] == "ath.actions-qualification.v1", "QUALIFICATION_VERSION_REJECTED")
        for name in ["repository", "sourceCommit", "runId", "runAttempt", "imageRef", "imageId"]:
            require(payload[name] == self.release[name], "QUALIFICATION_RELEASE_MISMATCH")
        require(payload["releaseSha256"] == self.request["releaseSha256"], "QUALIFICATION_RELEASE_MISMATCH")
        match(payload["evidenceSha256"], r"[a-f0-9]{64}", "QUALIFICATION_EVIDENCE_REJECTED")
        keys(payload["checks"], ["applicationRolesMatched", "ready", "migrationsMatched", "localSelfTestConfirmed"])
        require(all(value is True for value in payload["checks"].values()), "QUALIFICATION_CHECKS_REJECTED")
        try:
            checked = datetime.datetime.fromisoformat(payload["checkedAt"].replace("Z", "+00:00"))
            require(checked.tzinfo is not None, "QUALIFICATION_DATE_REJECTED")
            age = datetime.datetime.now(datetime.timezone.utc) - checked
            if enforce_age:
                require(-300 <= age.total_seconds() <= self.cfg["qualificationMaxAgeHours"] * 3600, "QUALIFICATION_EXPIRED")
        except (ValueError, TypeError, AttributeError) as error:
            raise Rejected("QUALIFICATION_DATE_REJECTED") from error
        result = self.node(VERIFY_SIGNATURE, {"publicKey": self.cfg["qualificationPublicKey"], "payload": envelope["payload"], "signature": envelope["signature"]}, with_env=False)
        require(result.get("valid") is True, "QUALIFICATION_SIGNATURE_REJECTED")
        return envelope

    def write(self, path, data, mode=0o600, exclusive=False):
        import pwd
        parent = ordinary(path.parent, True)
        require(parent.st_uid in [0, pwd.getpwnam(self.cfg["opsUser"]).pw_uid] and parent.st_mode & 0o022 == 0, "WRITABLE_PARENT_REJECTED")
        existing = None
        if path.exists():
            ordinary(path)
            require(not exclusive, "IMMUTABLE_RECORD_EXISTS")
            existing = path.stat()
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
                if existing:
                    os.fchown(stream.fileno(), existing.st_uid, existing.st_gid)
                    os.fchmod(stream.fileno(), stat.S_IMODE(existing.st_mode))
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def persist(self, phase, **fields):
        self.state.update(fields)
        self.state.update(phase=phase, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.write(self.operation / "state.json", (json.dumps(self.state) + "\n").encode())

    def qualify(self):
        envelope = self.qualification(True)
        directory = self.state_root / "qualifications"
        directory.mkdir(mode=0o700, exist_ok=True)
        trusted(directory, True, True)
        path = directory / (self.request["releaseSha256"] + ".json")
        record = {"releaseSha256": self.request["releaseSha256"], "qualification": envelope}
        history = directory / "history"
        history.mkdir(mode=0o700, exist_ok=True)
        trusted(history, True, True)

        def archive(value):
            encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
            target = history / (self.request["releaseSha256"] + "-" + sha_bytes(encoded) + ".json")
            if target.exists():
                trusted(target, private=True)
                require(target.read_bytes() == encoded, "QUALIFICATION_HISTORY_CONFLICT")
            else:
                self.write(target, encoded, exclusive=True)

        if path.exists():
            trusted(path, private=True)
            previous = decode_json(path.read_bytes())
            keys(previous, ["releaseSha256", "qualification"])
            require(previous["releaseSha256"] == record["releaseSha256"], "QUALIFICATION_RECORD_MISMATCH")
            if previous != record:
                self.qualification(True, previous["qualification"], False)
                parse_date = lambda value: datetime.datetime.fromisoformat(decode_json(base64.b64decode(value["payload"]))["checkedAt"].replace("Z", "+00:00"))
                require(parse_date(envelope) > parse_date(previous["qualification"]), "QUALIFICATION_RENEWAL_NOT_NEWER")
                archive(previous)
                archive(record)
                self.write(path, (json.dumps(record) + "\n").encode())
            else:
                archive(record)
        else:
            archive(record)
            self.write(path, (json.dumps(record) + "\n").encode(), exclusive=True)
        return {"qualified": True, "releaseSha256": self.request["releaseSha256"], "applicationChanged": False}

    def roles(self):
        result = {}
        for name in ["api", "apiWorker", "aiWorker"]:
            result[name] = decode_json(self.docker(["inspect", self.cfg["containers"][name]]))[0]
            require(result[name]["State"]["Running"], "APPLICATION_ROLE_NOT_RUNNING")
        require(len({value["Image"] for value in result.values()}) == 1, "MIXED_APPLICATION_IMAGES")
        return result

    def http(self, path):
        try:
            with urllib.request.urlopen(self.cfg["healthOrigin"] + path, timeout=4) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
        except (OSError, urllib.error.URLError):
            return 0

    def wait_http(self, path, expected, seconds=50):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if self.http(path) == expected:
                return
            time.sleep(0.4)
        raise Rejected("EXPECTED_HEALTH_NOT_REACHED")

    def tree_digest(self, root):
        ordinary(root, True)
        result = {}
        for path in sorted(root.rglob("*")):
            require(not path.is_symlink(), "PRIVATE_LINK_REJECTED")
            if path.is_file():
                result[str(path.relative_to(root))] = sha_file(path)
        return result

    def proxy_snapshot(self):
        proxy = self.cfg["proxy"]
        if proxy is None:
            return None
        ordinary(Path(proxy["configFile"]))
        with urllib.request.urlopen(proxy["adminOrigin"] + "/config/", timeout=4) as response:
            active = sha_bytes(response.read(4 * 1024 * 1024 + 1))
        return {"config": sha_file(Path(proxy["configFile"])), "active": active, "pid": self.system("show", proxy["unit"], "--property=MainPID", "--value")}

    def plan(self):
        qualified = self.qualification() is not None
        snapshot = self.snapshot()
        self.roles()
        present = self.image(self.release["imageRef"], True) is not None
        ready = self.http("/api/v1/health/ready") == 200
        return {"action": "plan", "readOnly": True, "qualified": qualified, "candidatePresent": present, "idle": self.idle(snapshot), "ready": ready, "migrationsMatched": True, "migrationCount": len(self.release["migrations"]), "canDeploy": qualified and self.idle(snapshot) and ready, "applicationChanged": False}

    def compose(self, roles):
        args = ["compose", "--env-file", self.cfg["cloudEnv"]]
        for path in self.cfg["composeFiles"]:
            args += ["-f", path]
        for profile in self.cfg["composeProfiles"]:
            args += ["--profile", profile]
        args += ["up", "-d", "--no-build", "--no-deps"]
        args += [self.cfg["services"][role] for role in roles]
        self.docker(args, 120)

    def pull(self):
        if self.image(self.release["imageRef"], True) is not None:
            return
        require(bool(self.request.get("registryToken")), "CANDIDATE_OR_REGISTRY_CREDENTIAL_REQUIRED")
        with tempfile.TemporaryDirectory(prefix="registry-", dir=self.operation) as directory:
            environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DOCKER_CONFIG": directory}
            token = self.request["registryToken"].encode() + b"\n"
            self.docker(["login", "ghcr.io", "--username", self.cfg["repository"].split("/")[0], "--password-stdin"], 40, token, environment)
            self.docker(["pull", "--platform", "linux/amd64", self.release["imageRef"]], 600, env=environment)
        self.image(self.release["imageRef"])

    def stage(self):
        destination = Path(self.cfg["releaseRoot"]) / ("actions-" + self.release["sourceCommit"][:12] + "-" + self.release["imageId"][7:19] + "-" + self.request["operationId"])
        require(not destination.exists(), "RELEASE_DIRECTORY_EXISTS_INSPECT_NO_REPLAY")
        available = os.statvfs(destination.parent).f_bavail * os.statvfs(destination.parent).f_frsize
        if available < 2 * 1024**3:
            self.persist(self.state["phase"], capacityWarning={
                "code": "LOW_RELEASE_STAGING_SPACE",
                "availableBytes": available,
                "warningBelowBytes": 2 * 1024**3,
            })
        destination.mkdir(mode=0o755)
        export = "aitesthub-actions-export-" + self.request["operationId"]
        self.docker(["create", "--network", "none", "--read-only", "--name", export, "--label", "aitesthub.actions-operation=" + self.request["operationId"], "--entrypoint", "/bin/true", self.candidate_daemon_id])
        try:
            container = decode_json(self.docker(["inspect", export]))[0]
            require(not container["State"]["Running"] and not container["Mounts"] and container["HostConfig"]["NetworkMode"] == "none", "EXPORT_CONTAINER_REJECTED")
            self.docker(["cp", export + ":/app", str(destination / "app")], 180)
            self.docker(["cp", export + ":/usr/local/bin/node", str(destination / "node")], 60)
            require(sha_file(destination / "node") == self.release["nodeSha256"], "NODE_PROOF_MISMATCH")
            expected = self.release["files"]
            actual = {"package.json": sha_file(destination / "app/package.json")}
            for name in ["dist", "apps/web/dist", "packages/persistence/migrations"]:
                directory = destination / "app" / name
                ordinary(directory, True)
                for path in directory.rglob("*"):
                    require(not path.is_symlink(), "RUNTIME_LINK_REJECTED")
                    if path.is_file():
                        actual[str(path.relative_to(destination / "app"))] = sha_file(path)
            require(actual == expected, "RUNTIME_PROOF_MISMATCH")
            self.write(destination / "release.json", base64.b64decode(self.request["releaseBytes"]), exclusive=True)
            for directory, subdirectories, filenames in os.walk(destination, followlinks=False):
                for name in subdirectories + filenames:
                    path = Path(directory) / name
                    os.chown(path, 0, 0, follow_symlinks=False)
                    if not path.is_symlink():
                        mode = path.stat().st_mode
                        os.chmod(path, 0o555 if path.is_dir() or mode & 0o111 else 0o444)
            os.chmod(destination / "node", 0o555)
            os.chmod(destination, 0o555)
        finally:
            container = decode_json(self.docker(["inspect", export]))[0]
            require(container["Config"]["Labels"].get("aitesthub.actions-operation") == self.request["operationId"] and not container["State"]["Running"], "EXPORT_OWNERSHIP_CHANGED")
            self.docker(["rm", export])
        return destination

    def backup(self):
        self.persist("backup-requesting", backupRequestedAfter=datetime.datetime.now(datetime.timezone.utc).isoformat())
        receipt = self.node(BACKUP_REQUEST)
        match(receipt.get("backupId"), r"[a-f0-9-]{36}", "BACKUP_RECEIPT_REJECTED")
        self.persist("backup-waiting", backupId=receipt["backupId"])
        end = time.monotonic() + 600
        while time.monotonic() < end:
            status = self.node(BACKUP_STATUS, {"backupId": receipt["backupId"]})
            if status["state"] == "complete":
                break
            require(status["state"] in ["queued", "preparing"], "PRODUCT_BACKUP_FAILED")
            time.sleep(1)
        else:
            raise Rejected("PRODUCT_BACKUP_NOT_COMPLETE")
        verified = self.node(BACKUP_VERIFY, {"backupId": receipt["backupId"]}, 180)
        require(verified.get("verified") is True, "BACKUP_NOT_AUTHENTICATED")
        self.persist("backup-authenticated", backupAuthenticated=True)

    def compare_roles(self, before, after, expected):
        require(all(item["Image"] == expected for item in after.values()), "APPLICATION_IMAGE_MISMATCH")
        for name in after:
            for field in ["User", "Cmd", "WorkingDir"]:
                require(after[name]["Config"][field] == before[name]["Config"][field], "APPLICATION_CONFIG_CHANGED")
            environment = lambda item: dict(value.split("=", 1) for value in item["Config"]["Env"])
            require(environment(after[name]) == environment(before[name]), "APPLICATION_ENVIRONMENT_CHANGED")
            for field in ["PortBindings", "Memory", "NanoCpus", "ReadonlyRootfs", "CapDrop", "SecurityOpt"]:
                require(after[name]["HostConfig"][field] == before[name]["HostConfig"][field], "APPLICATION_RESOURCE_POLICY_CHANGED")
            mounts = lambda item: sorted((mount["Destination"], mount["Source"], mount.get("RW")) for mount in item["Mounts"])
            require(mounts(after[name]) == mounts(before[name]), "APPLICATION_MOUNTS_CHANGED")

    def ops_argv(self, runtime, layout):
        node = str(runtime / "node")
        if layout == "bounded-relative":
            return [node, "--max-old-space-size=96", "dist/scripts/operations-worker.js"]
        if layout == "legacy-absolute":
            return [node, str(runtime / "app" / "dist/scripts/operations-worker.js")]
        raise Rejected("OPS_DROPIN_LAYOUT_REJECTED")

    def dropin(self, runtime, layout="bounded-relative"):
        return ("[Service]\nWorkingDirectory=" + str(runtime / "app") + "\nExecStart=\nExecStart=" + " ".join(self.ops_argv(runtime, layout)) + "\n").encode()

    def existing_dropin_layout(self, runtime, raw):
        for layout in ("bounded-relative", "legacy-absolute"):
            if raw == self.dropin(runtime, layout):
                return layout
        raise Rejected("OPS_DROPIN_CHANGED")

    def assert_effective_ops_argv(self, runtime, layout):
        summary = self.system("show", self.cfg["opsUnit"], "-p", "ExecStart", "--value")
        argv = re.search(r"argv\[\]=(.+?)(?:\s+;\s|$)", summary)
        require(argv is not None and shlex.split(argv[1]) == self.ops_argv(runtime, layout), "OPS_EFFECTIVE_ARGV_CHANGED")

    def deploy(self):
        self.qualification(True)
        before = self.snapshot()
        require(self.idle(before), "APPLICATION_NOT_IDLE")
        previous = self.roles()
        require(self.http("/api/v1/health/ready") == 200, "APPLICATION_NOT_READY")
        require(self.system("is-active", self.cfg["opsUnit"]) == "active", "OPS_NOT_ACTIVE")
        old_runtime = self.runtime
        env_path, dropin_path = Path(self.cfg["cloudEnv"]), Path(self.cfg["opsDropIn"])
        ordinary(env_path)
        ordinary(dropin_path)
        old_env, old_dropin = env_path.read_bytes(), dropin_path.read_bytes()
        ops_layout = self.existing_dropin_layout(old_runtime, old_dropin)
        self.assert_effective_ops_argv(old_runtime, ops_layout)
        compose_files = ",".join(self.cfg["composeFiles"])
        require(all(row["Config"]["Labels"].get("com.docker.compose.project.config_files") == compose_files for row in previous.values()), "COMPOSE_BINDING_CHANGED")
        require(len(re.findall(rb"^AITESTHUB_APP_IMAGE=.*$", old_env, re.M)) == 1, "IMAGE_SELECTION_REJECTED")
        private = Path(self.cfg["privateRoot"])
        secrets, configuration, proxy = self.tree_digest(private / "secrets"), self.tree_digest(private / "configuration"), self.proxy_snapshot()
        self.operation.mkdir(mode=0o700)
        self.write(self.operation / "cloud.env.before", old_env, exclusive=True)
        self.write(self.operation / "ops-dropin.before", old_dropin, exclusive=True)
        self.persist("preflight-safe", oldImageId=previous["api"]["Image"], opsDropinLayout=ops_layout)
        try:
            self.docker(["tag", previous["api"]["Image"], "aitesthub:actions-rollback-" + self.request["operationId"]])
            self.pull()
            destination = self.stage()
            new_dropin = self.dropin(destination, ops_layout)
            self.persist("candidate-staged", daemonImageId=self.candidate_daemon_id)
            self.backup()
        except Exception:
            unknown_backup = self.state["phase"] == "backup-requesting" and not self.state.get("backupId")
            self.persist("failed-before-application-switch", failedPhase=self.state["phase"], released=False, applicationChanged=False, rollbackPerformed=False, backupResultUnknown=unknown_backup, requiresManualRecovery=unknown_backup)
            return self.state
        entered = stopped = switched = released = False
        new_env = None
        phase = "draining"
        try:
            self.persist(phase)
            entered = True
            fenced = self.node(MAINTENANCE, {"action": "enter"}, 50)
            require(fenced["maintenance"]["phase"] == "snapshot" and fenced["active"]["total"] == 0, "DRAIN_FAILED")
            at_fence = self.snapshot()
            require(at_fence["modelDigest"] == before["modelDigest"] and at_fence["migrations"] == before["migrations"], "BASELINE_CHANGED")
            require(all(at_fence["counts"][name] == 0 for name in ["ai", "auxiliary", "dispatch", "backups", "runs"]), "ACTIVE_WORK_REMAINING")
            phase = "stopping-workers"
            self.persist(phase)
            stopped = True
            self.docker(["stop", "--time", "30", self.cfg["containers"]["apiWorker"], self.cfg["containers"]["aiWorker"]], 75)
            self.system("stop", self.cfg["opsUnit"])
            require(env_path.read_bytes() == old_env and dropin_path.read_bytes() == old_dropin, "CONFIGURATION_CHANGED_DURING_RELEASE")
            selected = self.release["imageRef"].encode()
            new_env = re.sub(rb"^AITESTHUB_APP_IMAGE=.*$", b"AITESTHUB_APP_IMAGE=" + selected, old_env, flags=re.M)
            switched = True
            self.write(env_path, new_env)
            phase = "starting-api"
            self.persist(phase)
            self.compose(["api"])
            self.wait_http("/api/v1/health/live", 200)
            require(self.http("/api/v1/health/ready") == 503, "MAINTENANCE_READINESS_NOT_CLOSED")
            self.runtime = destination
            candidate = self.snapshot()
            require(candidate["modelDigest"] == before["modelDigest"] and candidate["migrations"] == before["migrations"], "CANDIDATE_CONTROL_STATE_CHANGED")
            require(candidate["maintenance"]["operation_id"] == self.request["operationId"] and candidate["active"]["total"] == 0, "OWNED_FENCE_LOST")
            phase = "starting-ops-and-workers"
            self.persist(phase)
            self.write(dropin_path, new_dropin)
            self.system("daemon-reload")
            self.compose(["apiWorker", "aiWorker"])
            self.system("start", self.cfg["opsUnit"])
            time.sleep(2)
            self.assert_effective_ops_argv(destination, ops_layout)
            self.compare_roles(previous, self.roles(), self.candidate_daemon_id)
            require(self.tree_digest(private / "secrets") == secrets and self.tree_digest(private / "configuration") == configuration, "PRIVATE_CONFIGURATION_CHANGED")
            require(self.proxy_snapshot() == proxy, "PROXY_CHANGED")
            final = self.snapshot()
            require(final["modelDigest"] == before["modelDigest"] and final["migrations"] == before["migrations"] and final["counts"]["ledger"] == at_fence["counts"]["ledger"], "FINAL_CONTROL_STATE_CHANGED")
            require(self.active_runtime() == destination and self.system("is-active", self.cfg["opsUnit"]) == "active", "OPS_RUNTIME_NOT_ACTIVE")
            phase = "releasing-fence"
            self.persist(phase)
            released_state = self.node(MAINTENANCE, {"action": "release"})
            require(released_state["maintenance"]["phase"] == "idle", "MAINTENANCE_RELEASE_FAILED")
            released = True
            self.wait_http("/api/v1/health/ready", 200)
            self.persist("complete", released=True, ready=True, rollbackPerformed=False, requiresManualRecovery=False)
        except Exception:
            restored = False
            try:
                self.runtime = old_runtime
                if entered:
                    refenced = self.node(MAINTENANCE, {"action": "enter"}, 50)
                    require(refenced["maintenance"]["phase"] == "snapshot" and refenced["maintenance"]["operation_id"] == self.request["operationId"] and refenced["active"]["total"] == 0, "ROLLBACK_FENCE_REJECTED")
                if stopped or switched:
                    self.docker(["stop", "--time", "30", self.cfg["containers"]["apiWorker"], self.cfg["containers"]["aiWorker"]], 75)
                    self.system("stop", self.cfg["opsUnit"])
                    require(env_path.read_bytes() in ([old_env, new_env] if new_env else [old_env]) and dropin_path.read_bytes() in [old_dropin, new_dropin], "ROLLBACK_CONFIGURATION_CHANGED")
                    self.write(env_path, old_env)
                    self.write(dropin_path, old_dropin)
                    self.system("daemon-reload")
                    self.compose(["api"])
                    self.wait_http("/api/v1/health/live", 200)
                    self.compose(["apiWorker", "aiWorker"])
                    self.system("start", self.cfg["opsUnit"])
                    time.sleep(2)
                self.runtime = old_runtime
                self.assert_effective_ops_argv(old_runtime, ops_layout)
                self.compare_roles(previous, self.roles(), previous["api"]["Image"])
                recovered = self.snapshot()
                require(recovered["migrations"] == before["migrations"] and recovered["modelDigest"] == before["modelDigest"], "ROLLBACK_STATE_CHANGED")
                require(self.active_runtime() == old_runtime and self.system("is-active", self.cfg["opsUnit"]) == "active", "ROLLBACK_OPS_NOT_ACTIVE")
                if entered:
                    self.node(MAINTENANCE, {"action": "release"})
                self.wait_http("/api/v1/health/ready", 200)
                restored = True
            except Exception:
                self.persist("failed-recovery-required", failedPhase=phase, released=False, rollbackPerformed=False, requiresManualRecovery=True)
            if restored:
                self.persist("failed-safe-rollback", failedPhase=phase, released=False, rollbackPerformed=stopped or switched, requiresManualRecovery=False)
            return self.state
        return self.state

    def status(self):
        path = self.operation / "state.json"
        if not path.exists():
            return {"operationId": self.request["operationId"], "phase": "not-found", "readOnly": True}
        trusted(path, private=True)
        state = decode_json(path.read_bytes())
        require(state.get("operationId") == self.request["operationId"], "OPERATION_STATE_MISMATCH")
        return {**state, "readOnly": True}


def load_configuration(path, digest):
    path = safe_path(path)
    trusted(path, private=True)
    raw = path.read_bytes()
    match(digest, r"[a-f0-9]{64}", "CONFIG_DIGEST_REQUIRED")
    require(sha_bytes(raw) == digest, "HOST_CONFIGURATION_CHANGED")
    value = decode_json(raw)
    keys(value, ["schemaVersion", "repository", "platformId", "privateRoot", "releaseRoot", "stateRoot", "cloudEnv", "opsEnv", "opsUnit", "opsUser", "opsDropIn", "composeFiles", "composeProfiles", "services", "containers", "healthOrigin", "proxy", "qualificationPublicKey", "qualificationMaxAgeHours"])
    require(value["schemaVersion"] == "ath.actions-host.v1", "HOST_CONFIGURATION_VERSION_REJECTED")
    match(value["repository"], r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", "REPOSITORY_REJECTED")
    match(value["platformId"], r"[a-f0-9-]{36}", "PLATFORM_ID_REJECTED")
    match(value["opsUnit"], r"[A-Za-z0-9_.-]+\.service", "OPS_UNIT_REJECTED")
    match(value["opsUser"], r"[a-z_][a-z0-9_-]{0,31}", "OPS_USER_REJECTED")
    require(isinstance(value["qualificationPublicKey"], str) and 64 <= len(value["qualificationPublicKey"]) <= 1024 and value["qualificationPublicKey"].startswith("-----BEGIN PUBLIC KEY-----"), "QUALIFICATION_PUBLIC_KEY_REQUIRED")
    require(type(value["qualificationMaxAgeHours"]) is int and 1 <= value["qualificationMaxAgeHours"] <= 720, "QUALIFICATION_AGE_REJECTED")
    for name in ["privateRoot", "releaseRoot", "stateRoot", "cloudEnv", "opsEnv", "opsDropIn"]:
        safe_path(value[name])
    require(Path(value["cloudEnv"]).parent == Path(value["privateRoot"]) and Path(value["opsEnv"]).parent == Path(value["privateRoot"]), "PRIVATE_ENV_ROOT_REJECTED")
    require(Path(value["stateRoot"]).is_relative_to(Path(value["privateRoot"]) / "setup"), "STATE_ROOT_REJECTED")
    trusted(Path(value["stateRoot"]), True, True)
    trusted(Path(value["stateRoot"]) / "operations", True, True)
    trusted(Path(value["stateRoot"]) / "qualifications", True, True)
    release_parent(Path(value["releaseRoot"]), value["opsUser"])
    require(isinstance(value["composeFiles"], list) and 1 <= len(value["composeFiles"]) <= 4, "COMPOSE_FILES_REJECTED")
    for file in value["composeFiles"]:
        ordinary(safe_path(file))
    require(isinstance(value["composeProfiles"], list) and len(value["composeProfiles"]) <= 4, "COMPOSE_PROFILES_REJECTED")
    for name in value["composeProfiles"]:
        match(name, r"[a-z][a-z0-9_-]{0,63}", "COMPOSE_PROFILE_REJECTED")
    keys(value["services"], ["api", "apiWorker", "aiWorker"])
    keys(value["containers"], ["api", "apiWorker", "aiWorker", "database"])
    for mapping in [value["services"], value["containers"]]:
        require(len(set(mapping.values())) == len(mapping), "DUPLICATE_ROLE_REJECTED")
        for name in mapping.values():
            match(name, r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", "ROLE_NAME_REJECTED")
    origins = [value["healthOrigin"]]
    if value["proxy"] is not None:
        keys(value["proxy"], ["unit", "configFile", "adminOrigin"])
        match(value["proxy"]["unit"], r"[A-Za-z0-9_.-]+\.service", "PROXY_UNIT_REJECTED")
        safe_path(value["proxy"]["configFile"])
        origins.append(value["proxy"]["adminOrigin"])
    for origin in origins:
        url = urllib.parse.urlsplit(origin)
        require(url.scheme == "http" and url.hostname == "127.0.0.1" and bool(url.port) and not url.username and not url.password and not url.path and not url.query and not url.fragment, "LOOPBACK_ORIGIN_REQUIRED")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    arguments = parser.parse_args()
    require(os.geteuid() == 0, "ROOT_INSTALLATION_REQUIRED")
    trusted(Path(__file__).absolute())
    cfg = load_configuration(arguments.config, arguments.config_sha256)
    request = read_request(sys.stdin.buffer.read(4 * 1024 * 1024 + 1))
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    if request.get("release"):
        require(request["release"]["repository"] == cfg["repository"], "REPOSITORY_MISMATCH")
    import fcntl
    lock_path = Path(cfg["stateRoot"]) / "operator.lock"
    flags = os.O_RDWR | os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags)
    try:
        trusted(lock_path, private=True)
        if request["action"] in ["deploy", "qualify"]:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Rejected("DEPLOYMENT_OPERATION_IN_PROGRESS") from error
        operator = Operator(cfg, request)
        if request["action"] == "deploy":
            require(not operator.operation.exists(), "OPERATION_ALREADY_EXISTS_USE_STATUS")
        result = getattr(operator, request["action"])()
        failed = request["action"] == "deploy" and result.get("released") is False
        print(json.dumps({"ok": not failed, **result}))
        return 1 if failed else 0
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Rejected as error:
        print(json.dumps({"ok": False, "error": str(error), "migrationsRun": 0, "modelRequests": 0}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"ok": False, "error": "HOST_OPERATION_FAILED_INSPECT_STATUS_NO_REPLAY", "migrationsRun": 0, "modelRequests": 0}))
        raise SystemExit(1)
