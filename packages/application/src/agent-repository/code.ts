/** Fixed read-only Git object program. No Git subprocess, checkout, hooks, remote or host paths. */
export const repositoryReadCode = String.raw`
import io,json,pathlib,stat,difflib
from dulwich.bundle import read_bundle
from dulwich.repo import MemoryRepo
from dulwich.objects import Commit,Tree,Blob
request=json.loads(pathlib.Path('inputs/request.json').read_text())
raw=b''.join(p.read_bytes() for p in sorted(pathlib.Path('inputs').glob('source-*.bin')))
if not raw.startswith((b'# v2 git bundle\n',b'# v3 git bundle\n')): raise ValueError('GIT_BUNDLE_REQUIRED')
repo=MemoryRepo()
with read_bundle(io.BytesIO(raw)) as bundle:
    if bundle.prerequisites: raise ValueError('INCREMENTAL_BUNDLE_NOT_SUPPORTED')
    if bundle.capabilities.get('object-format','sha1')!='sha1': raise ValueError('OBJECT_FORMAT_NOT_SUPPORTED')
    if bundle.pack_data is None or len(bundle.pack_data)>40000: raise ValueError('BUNDLE_OBJECT_LIMIT')
    bundle.store_objects(repo.object_store)
    refs=sorted((name.decode('utf8','replace'),sha.decode('ascii')) for name,sha in bundle.references.items())
if len(refs)>2000: raise ValueError('REFERENCE_LIMIT')
total_bytes=0
for sha in repo.object_store:
    total_bytes+=len(repo.object_store[sha].as_raw_string())
    if total_bytes>64*1024*1024: raise ValueError('BUNDLE_EXPANSION_LIMIT')
def checked_commit(value):
    obj=repo.object_store[value.encode('ascii')]
    if not isinstance(obj,Commit): raise ValueError('COMMIT_REQUIRED')
    return obj

def commit_metadata(value):
    obj=checked_commit(value)
    if len(obj.parents)>64: raise ValueError('COMMIT_PARENT_LIMIT')
    parents=[]
    for parent in obj.parents:
        parent_sha=parent.decode('ascii')
        if len(parent_sha)!=40 or any(c not in '0123456789abcdef' for c in parent_sha): raise ValueError('COMMIT_PARENT_INVALID')
        if parent not in repo.object_store or not isinstance(repo.object_store[parent],Commit): raise ValueError('BUNDLE_PARENT_MISSING')
        parents.append(parent_sha)
    return {'commit':value,'parents':parents}
def entries(commit):
    found=[]
    def walk(tree_id,prefix,depth):
        if depth>64: raise ValueError('TREE_DEPTH_LIMIT')
        tree=repo.object_store[tree_id]
        if not isinstance(tree,Tree): raise ValueError('TREE_REQUIRED')
        for name,mode,sha in tree.iteritems():
            name=name.decode('utf8','strict')
            if '/' in name or '\\' in name or name in ('.','..','.git') or any(ord(c)<32 for c in name): raise ValueError('TREE_PATH_INVALID')
            path=prefix+name
            if len(path)>1000: raise ValueError('TREE_PATH_LIMIT')
            kind='directory' if stat.S_ISDIR(mode) else 'symlink' if stat.S_ISLNK(mode) else 'submodule' if mode==0o160000 else 'file'
            obj=repo.object_store[sha] if kind not in ('submodule',) else None
            found.append({'path':path,'kind':kind,'objectId':sha.decode('ascii'),'sizeBytes':len(obj.data) if isinstance(obj,Blob) else None})
            if len(found)>100000: raise ValueError('TREE_ENTRY_LIMIT')
            if kind=='directory': walk(sha,path+'/',depth+1)
    walk(commit.tree,'',0)
    return sorted(found,key=lambda x:x['path'])
def text_at(commit,path):
    match=next((e for e in entries(commit) if e['path']==path),None)
    if not match or match['kind']!='file': raise ValueError('REGULAR_FILE_REQUIRED')
    blob=repo.object_store[match['objectId'].encode('ascii')]
    if not isinstance(blob,Blob) or len(blob.data)>2*1024*1024: raise ValueError('FILE_SIZE_LIMIT')
    if b'\0' in blob.data: raise ValueError('BINARY_FILE_NOT_TEXT')
    return blob.data.decode('utf8','strict').splitlines()
action=request['action'];offset=request.get('offset',0);limit=request.get('limit',80)
result={'action':action,'commit':request.get('commit'),'baseCommit':request.get('baseCommit'),'references':[],'commits':[],'entries':[],'text':'','offset':offset,'nextOffset':None,'total':0,'partial':False}
if action=='inspect':
    result['references']=[{'name':name,'commit':sha} for name,sha in refs]
    result['total']=len(refs)
    seen=set()
    for _,sha in refs:
        if sha in seen or not isinstance(repo.object_store[sha.encode('ascii')],Commit): continue
        seen.add(sha)
        result['commits'].append(commit_metadata(sha))
        if len(result['commits'])==8: break
else:
    current=checked_commit(request['commit'])
    if action=='history':
        result['commits']=[commit_metadata(request['commit'])]
        result['total']=1
    elif action=='tree':
        values=[e for e in entries(current) if not request.get('prefix') or e['path']==request['prefix'] or e['path'].startswith(request['prefix']+'/')]
        result['total']=len(values);result['entries']=values[offset:offset+limit]
    elif action=='read':
        values=text_at(current,request['path']);result['total']=len(values)
        result['text']='\n'.join(str(i+1)+': '+line for i,line in enumerate(values[offset:offset+limit],offset))
    elif action=='diff':
        base=checked_commit(request['baseCommit'])
        if request.get('path'):
            left=next((e for e in entries(base) if e['path']==request['path']),None)
            right=next((e for e in entries(current) if e['path']==request['path']),None)
            values=list(difflib.unified_diff(text_at(base,request['path']) if left else [],text_at(current,request['path']) if right else [],fromfile=request['baseCommit']+':'+request['path'],tofile=request['commit']+':'+request['path'],lineterm=''))
            result['total']=len(values);result['text']='\n'.join(values[offset:offset+limit])
        else:
            a={e['path']:e for e in entries(base) if e['kind']!='directory'};b={e['path']:e for e in entries(current) if e['kind']!='directory'}
            values=[{'path':path,'kind':'changed','objectId':b.get(path,a.get(path))['objectId'],'sizeBytes':b.get(path,a.get(path))['sizeBytes']} for path in sorted(set(a)|set(b)) if a.get(path)!=b.get(path)]
            result['total']=len(values);result['entries']=values[offset:offset+limit]
    if offset+limit<result['total']:result['nextOffset']=offset+limit;result['partial']=True
if len(result['text'])>60000:
    raise ValueError('LINE_TEXT_LIMIT_USE_SMALLER_RANGE')
print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
`;
