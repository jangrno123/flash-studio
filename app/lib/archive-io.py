"""Local archive I/O using Python's standard library, without PowerShell modules."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import zipfile

MAX_ENTRIES=10000
MAX_TOTAL=8*1024**3
MAX_FILE=2*1024**3

def safe_name(name):
    name=name.replace('\\','/')
    parts=PurePosixPath(name).parts
    if not parts or name.startswith('/') or any(p in ('..','.') for p in parts):
        raise ValueError('Unsafe archive path: '+name)
    if any(re.search(r'[\x00-\x1f<>:"|?*]',p) or p.endswith((' ','.')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p,re.I) for p in parts):
        raise ValueError('Unsupported Windows archive path: '+name)
    return '/'.join(parts)

def crc_file(path):
    import zlib
    crc=0
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):crc=zlib.crc32(chunk,crc)
    return crc & 0xffffffff

def digest_file(path):
    with path.open('rb') as stream:
        return digest_stream(stream)

def digest_stream(stream):
    h=hashlib.sha256()
    for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def open_archive(source):
    if zipfile.is_zipfile(source):
        archive=zipfile.ZipFile(source)
        entries=[]
        for info in archive.infolist():
            mode=(info.external_attr>>16)&0o170000
            entries.append({'name':info.filename,'directory':info.is_dir(),'bytes':info.file_size,'compressedBytes':info.compress_size,'encrypted':bool(info.flag_bits&1),'link':mode==0o120000,'crc':info.CRC,'handle':info})
        return archive,'zip',entries,lambda entry:archive.open(entry['handle'])
    try:
        archive=tarfile.open(source,'r:*')
    except (tarfile.TarError,OSError):
        raise ValueError('지원하는 압축 형식은 ZIP, TAR, TAR.GZ/TGZ, TAR.BZ2, TAR.XZ입니다. 암호화 ZIP·RAR·7z는 별도 도구가 필요합니다.')
    entries=[{'name':i.name,'directory':i.isdir(),'bytes':i.size,'compressedBytes':None,'encrypted':False,'link':not(i.isfile() or i.isdir()),'handle':i} for i in archive.getmembers()]
    return archive,'tar',entries,lambda entry:archive.extractfile(entry['handle'])

def archive_task(request):
    source=Path(request['source']).resolve(strict=True)
    archive,kind,entries,opener=open_archive(source)
    try:
        total=sum(e['bytes'] for e in entries if not e['directory'])
        if len(entries)>MAX_ENTRIES:
            raise ValueError('압축 항목은 10,000개 이하로 준비하세요.')
        if request['action']=='list':
            start=request.get('offset',0);limit=request.get('max_results',100)
            return {'format':kind,'source':str(source),'totalEntries':len(entries),'totalBytes':total,'offset':start,'hasMore':start+limit<len(entries),'entries':[{k:v for k,v in e.items() if k not in ('handle','crc')} for e in entries[start:start+limit]]}
        wanted=request.get('members')
        selected=[e for e in entries if not wanted or e['name'] in wanted]
        if wanted and set(wanted)-{e['name'] for e in selected}:raise ValueError('압축 안에서 선택한 파일을 찾지 못했습니다.')
        if sum(e['bytes'] for e in selected)>MAX_TOTAL or any(e['bytes']>MAX_FILE for e in selected):raise ValueError('선택한 해제 파일은 전체 8GB, 파일당 2GB 이하입니다. 필요한 members만 선택하세요.')
        # Validate every selected path before creating any output file.
        seen={}
        for entry in selected:
            if entry['encrypted']:raise ValueError('암호화된 ZIP입니다. 암호가 필요한 압축은 자동 해제하지 않습니다.')
            if entry['link']:raise ValueError('압축 안의 심볼릭 링크·하드 링크·특수 파일은 해제하지 않습니다.')
            name=safe_name(entry['name']);entry['safeName']=name
            if name.casefold() in seen and not(entry['directory'] and seen[name.casefold()]):raise ValueError('중복·대소문자 충돌 경로: '+name)
            seen[name.casefold()]=entry['directory']
        destination=Path(request['destination']).resolve()
        roots=[Path(r).resolve() for r in request['allowed_roots']]
        if not any(destination.is_relative_to(r) for r in roots):raise ValueError('압축 해제 대상이 허용 폴더 밖입니다.')
        plan=[]
        for entry in selected:
            target=(destination/entry['safeName']).resolve()
            if not target.is_relative_to(destination):raise ValueError('압축 해제 경로가 대상 폴더 밖입니다.')
            if target.exists() and not entry['directory']:
                same=target.is_file() and target.stat().st_size==entry['bytes']
                if same and kind=='zip':same=crc_file(target)==entry['crc']
                elif same:
                    with opener(entry) as src:same=digest_stream(src)==digest_file(target)
                if not same:raise ValueError('기존 파일을 덮어쓰지 않습니다: '+str(target))
                entry['skip']=True
            plan.append((entry,target))
        destination.mkdir(parents=True,exist_ok=True)
        needed=sum(e['bytes'] for e,t in plan if not e['directory'] and not e.get('skip'))
        if needed>shutil.disk_usage(destination).free-256*1024*1024:raise ValueError('압축 해제 공간이 부족합니다.')
        extracted=[];skipped=0
        for entry,target in plan:
            if entry['directory']:target.mkdir(parents=True,exist_ok=True);continue
            if entry.get('skip'):skipped+=1;continue
            target.parent.mkdir(parents=True,exist_ok=True)
            # Recheck after directory creation to prevent junction traversal.
            if not target.parent.resolve().is_relative_to(destination):raise ValueError('압축 해제 중 경로가 바뀌었습니다.')
            try:
                with opener(entry) as src,target.open('xb') as out:
                    copied=0
                    while True:
                        chunk=src.read(1024*1024)
                        if not chunk:break
                        copied+=len(chunk)
                        if copied>entry['bytes'] or copied>MAX_FILE:raise ValueError('압축 파일의 표시 크기와 실제 크기가 다릅니다.')
                        out.write(chunk)
                if copied!=entry['bytes']:raise ValueError('압축 파일이 불완전합니다.')
            except FileExistsError:
                raise ValueError('해제 중 같은 이름의 파일이 생겨 중단했습니다: '+str(target))
            except Exception:
                # Only the incomplete file created by this operation is removed.
                target.unlink(missing_ok=True)
                raise
            extracted.append(str(target))
        files=[str(t) for e,t in plan if not e['directory']]
        return {'format':kind,'source':str(source),'destination':str(destination),'files':files[:200],'fileCount':len(files),'extracted':len(extracted),'skippedExistingIdentical':skipped,'totalBytes':sum(e['bytes'] for e,t in plan if not e['directory']),'hasMoreFiles':len(files)>200}
    finally:
        archive.close()

def create_archive(request):
    destination=Path(request['destination']).resolve()
    if destination.exists():raise ValueError('기존 압축 파일을 덮어쓰지 않습니다. 새 destination을 지정하세요.')
    files=[];names=set()
    for src in request['sources']:
        source=Path(src).resolve(strict=True)
        items=[source] if source.is_file() else source.rglob('*')
        for item in items:
            if item.is_symlink() or getattr(item,'is_junction',lambda:False)():raise ValueError('링크를 따라 압축하지 않습니다.')
            if not item.is_file():continue
            if not item.resolve().is_relative_to(source if source.is_dir() else source.parent):raise ValueError('소스 폴더 밖의 링크 파일입니다.')
            name=source.name if source.is_file() else source.name+'/'+item.relative_to(source).as_posix()
            name=safe_name(name)
            if name.casefold() in names:raise ValueError('압축 안 파일 이름 충돌: '+name)
            names.add(name.casefold());files.append((item,name))
    if len(files)>MAX_ENTRIES or sum(f.stat().st_size for f,n in files)>MAX_TOTAL:raise ValueError('압축 생성 크기 한도를 초과합니다.')
    destination.parent.mkdir(parents=True,exist_ok=True)
    temp=destination.with_name(destination.name+'.partial-'+str(os.getpid()))
    owns_output=False
    try:
        with zipfile.ZipFile(temp,'x',compression=zipfile.ZIP_DEFLATED,allowZip64=True) as archive:
            for source,name in files:archive.write(source,name)
        # Exclusive publication preserves a file created by another request.
        with temp.open('rb') as src,destination.open('xb') as out:
            owns_output=True
            shutil.copyfileobj(src,out)
    except Exception:
        if owns_output:destination.unlink(missing_ok=True)
        raise
    finally:temp.unlink(missing_ok=True)
    return {'format':'zip','destination':str(destination),'fileCount':len(files),'bytes':destination.stat().st_size,'sha256':digest_file(destination)}

def main():
    request=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    result=create_archive(request) if request['action']=='create' else archive_task(request)
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False));sys.exit(1)
