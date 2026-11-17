// Fixed bootstrap, executed only inside the disposable container. It is not the isolation boundary.
export const pythonBootstrap = String.raw`
import base64, json, os, pathlib, selectors, stat, subprocess, sys

MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_FILES = 32
MAX_TEXT = 256 * 1024

request = json.load(sys.stdin)
root = pathlib.Path('/workspace')
os.chdir(root)
for entry in request['files']:
    path = root / entry['path']
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(entry['contentBase64'], validate=True))
stdout = bytearray()
stderr = bytearray()
state = 'completed'
# Capture operating-system pipes, including subprocess output and os.write(). Python's
# redirect_stdout alone can be bypassed by ordinary libraries and is not sufficient here.
process = subprocess.Popen([sys.executable, '-I', '-B', '-c', request['code']],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ, stdout)
selector.register(process.stderr, selectors.EVENT_READ, stderr)
while selector.get_map():
    for key, events in selector.select():
        chunk = os.read(key.fd, 16384)
        if not chunk:
            selector.unregister(key.fileobj)
            continue
        target = key.data
        remaining = MAX_TEXT - len(target)
        target.extend(chunk[:max(remaining, 0)])
        if len(chunk) > remaining:
            state = 'output_limit'
            process.kill()
            selector.close()
            break
    if state == 'output_limit':
        break
process.stdout.close()
process.stderr.close()
returncode = process.wait()
if state != 'output_limit' and returncode != 0:
    state = 'code_error'

files = []
total = 0
try:
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not pathlib.Path(directory, d).is_symlink())
        for name in sorted(names):
            path = pathlib.Path(directory, name)
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                continue
            if info.st_size > MAX_FILE or len(files) >= MAX_FILES:
                raise OverflowError()
            # O_NOFOLLOW denies replacing the final component by a symlink during export.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    continue
                with os.fdopen(fd, 'rb', closefd=False) as source:
                    content = source.read(MAX_FILE + 1)
            finally:
                os.close(fd)
            total += len(content)
            if len(content) > MAX_FILE or total > MAX_TOTAL:
                raise OverflowError()
            files.append({'path': path.relative_to(root).as_posix(), 'contentBase64': base64.b64encode(content).decode('ascii')})
except BaseException:
    state = 'output_limit'
    files = []

sys.stdout.write(json.dumps({'state': state, 'stdout': stdout.decode('utf-8', errors='replace'), 'stderr': stderr.decode('utf-8', errors='replace'), 'files': files}))
`;
