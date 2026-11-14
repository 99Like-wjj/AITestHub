"""Rendered locally for one exact release; stage public code/image only.
No DB migration, identity/secret creation, service switch, model or business call.
Do not invoke until Root completes the local acceptance and authorizes execution.
"""
import datetime, hashlib, json, os, pathlib, stat, subprocess, sys, tarfile
plan_file = pathlib.Path(sys.argv[1])
assert plan_file.is_absolute() and plan_file.is_file() and (not plan_file.is_symlink())
raw = plan_file.read_bytes()
assert len(raw) < 262144 and hashlib.sha256(raw).hexdigest() == sys.argv[2]
PLAN = json.loads(raw)
PROFILE = PLAN['profile']
IMAGE = PLAN['imageId']
PLATFORM = PROFILE['platformId']
OLD = PROFILE['oldImage']
ROOT = pathlib.Path(PLAN['releaseRoot'])
assert PLAN['schemaVersion'] == 'ath.cloud36-operator-package.v1'
assert PLAN['platformId'] == PLATFORM
assert str(ROOT) == PROFILE['releaseRoot'] + '/36-' + IMAGE[7:19]
assert ROOT.resolve() == ROOT and (ROOT / 'artifacts').resolve() == ROOT / 'artifacts'

def run(args):
    result = subprocess.run(args, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=180)
    if result.returncode:
        raise RuntimeError('EXACT_CLOUD36_STAGE_COMMAND_FAILED: ' + args[0])
    return result.stdout.strip()

def docker(args):
    return run(['sudo', '-n', 'docker'] + args)

def file_hash(path):
    metadata = path.lstat()
    assert stat.S_ISREG(metadata.st_mode) and (not path.is_symlink())
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def current():
    query = "SELECT json_build_object('platform',(SELECT platform_id FROM app.recovery_control_state WHERE singleton),\n      'lastMigration',(SELECT max(version) FROM app.schema_migrations),'migrationCount',(SELECT count(*) FROM app.schema_migrations),\n      'models',(SELECT json_agg(x) FROM (SELECT id,config_revision,row_version FROM app.model_services ORDER BY id)x),\n      'modelHistory',(SELECT count(*) FROM app.model_service_revisions),'modelLedger',(SELECT count(*) FROM app.model_call_ledger),\n      'apiAttempts',(SELECT count(*) FROM app.api_step_attempts))"
    text = run(['sudo', '-n', 'docker', 'exec', PROFILE['containers']['database'], 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'aitesthub_admin', '-d', 'aitesthub', '-c', 'BEGIN TRANSACTION READ ONLY; ' + query + '; COMMIT;'])
    result = json.loads(text)
    assert result['platform'] == PLATFORM and result['lastMigration'] == '0033_ui_delivery.sql' and (result['migrationCount'] == 33)
    assert (result['models'] or []) == [{'id': m['id'], 'config_revision': m['revision'], 'row_version': m['revision']} for m in sorted(PROFILE['legacyModels'], key=lambda x: x['id'])]
    assert result['modelHistory'] == sum((m['revision'] for m in PROFILE['legacyModels'])) and result['modelLedger'] == 0 and (result['apiAttempts'] == 0)
    return result
before = current()
space = os.statvfs(str(ROOT))
available = space.f_bavail * space.f_frsize
assert available >= max(2 * 1024 ** 3, PLAN['imageArchive']['bytes'] * 8), 'INSUFFICIENT_RELEASE_STAGING_SPACE'
for name in [PROFILE['containers']['api'], PROFILE['containers']['apiWorker'], PROFILE['containers']['aiWorker']]:
    assert json.loads(docker(['inspect', name]))[0]['Image'] == OLD
for item in [PLAN['imageArchive'], PLAN['operatorArchive']]:
    assert pathlib.Path(item['name']).name == item['name']
    path = ROOT / 'artifacts' / item['name']
    assert path.stat().st_size == item['bytes']
    assert file_hash(path) == item['sha256']
archive = ROOT / 'artifacts' / PLAN['operatorArchive']['name']
with tarfile.open(archive, 'r:gz') as handle:
    members = handle.getmembers()
    files = {item.name: item for item in members if item.isfile()}
    assert len(files) == len([item for item in members if item.isfile()])
    assert set(files) == set(PLAN['files'])
    assert all((item.isfile() or (item.isdir() and item.name.rstrip('/') == 'operator') for item in members))
    for name, checksum in PLAN['files'].items():
        assert not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
        assert hashlib.sha256(handle.extractfile(files[name]).read()).hexdigest() == checksum
present = [(ROOT / name).exists() for name in PLAN['files']]
assert all(present) or not any(present), 'PARTIAL_OPERATOR_EXTRACTION_REQUIRES_REVIEW'
if not any(present):
    run(['sudo', '-n', 'tar', '-xzf', str(archive), '-C', str(ROOT), '--no-same-owner', '--keep-old-files'])
for name, checksum in PLAN['files'].items():
    assert file_hash(ROOT / name) == checksum
imagePresent = subprocess.run(['sudo', '-n', 'docker', 'image', 'inspect', IMAGE], capture_output=True, text=True).returncode == 0
if not imagePresent:
    docker(['load', '-i', str(ROOT / 'artifacts' / PLAN['imageArchive']['name'])])
assert json.loads(docker(['image', 'inspect', IMAGE]))[0]['Id'] == IMAGE
export = PLAN['exportContainerName']
assert export.startswith('aitesthub-export36-')
existing = subprocess.run(['sudo', '-n', 'docker', 'inspect', export], capture_output=True, text=True)
created = False
if existing.returncode:
    docker(['create', '--network', 'none', '--name', export, '--label', 'aitesthub.cloud36.export=' + PLAN['id'], '--entrypoint', '/bin/true', IMAGE])
    created = True
try:
    container = json.loads(docker(['inspect', export]))[0]
    assert container['Image'] == IMAGE and container['State']['Status'] == 'created' and (container['HostConfig']['NetworkMode'] == 'none')
    assert container['Config']['Labels']['aitesthub.cloud36.export'] == PLAN['id'] and container['Mounts'] == []
    if not (ROOT / 'app').exists():
        docker(['cp', export + ':/app', str(ROOT / 'app')])
    if not (ROOT / 'node').exists():
        docker(['cp', export + ':/usr/local/bin/node', str(ROOT / 'node')])
    proof = json.loads((ROOT / 'build-proof.json').read_text())
    assert proof['imageId'] == IMAGE
    assert file_hash(ROOT / 'build-proof.json') == PLAN['buildProofSha256']
    assert file_hash(ROOT / 'node') == proof['nodeSha256']
    for name, checksum in proof['files'].items():
        assert file_hash(ROOT / 'app' / name) == checksum
    for path in ['app', 'node', 'operator', 'build-proof.json']:
        candidate = ROOT / path
        assert candidate.resolve() == candidate
        run(['sudo', '-n', 'chown', '-R', 'root:root', str(candidate)])
        run(['sudo', '-n', 'chmod', '-R', 'a+rX', str(candidate)])
        run(['sudo', '-n', 'chmod', '-R', 'a-w', str(candidate)])
    run(['sudo', '-n', 'chmod', '0555', str(ROOT / 'node')])
    run(['sudo', '-n', 'chown', '-R', 'root:root', str(ROOT / 'artifacts')])
    run(['sudo', '-n', 'chmod', '-R', 'a+rX', str(ROOT / 'artifacts')])
    run(['sudo', '-n', 'chmod', '-R', 'a-w', str(ROOT / 'artifacts')])
    run(['sudo', '-n', 'chown', 'root:root', str(ROOT)])
    run(['sudo', '-n', 'chmod', '0555', str(ROOT)])
finally:
    owned = json.loads(docker(['inspect', export]))[0]
    assert owned['Config']['Labels']['aitesthub.cloud36.export'] == PLAN['id'] and (not owned['State']['Running'])
    docker(['rm', export])
after = current()
assert before == after
print(json.dumps({'schemaVersion': 'ath.cloud36-staged.v1', 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': IMAGE, 'releaseRoot': str(ROOT), 'publicArtifactsStaged': True, 'databaseMigrations': 0, 'servicesSwitched': False, 'secretFilesChanged': False, 'providerRequests': 0, 'businessRequests': 0, 'selectedDatabaseMetadataUnchanged': True, 'singleStagingFreeBytesCheck': available}, indent=2))
