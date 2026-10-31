#!/usr/bin/env python3
"""Read-only H3 service/profile inventory. No writes, start, claim or inference."""
import argparse, hashlib, json, os, re, shlex, subprocess
from pathlib import Path
PROFILES={"int8":("config.json","models-manifest.json"),"ref2va-bf16":("config.ref2va-bf16.json","models-manifest.ref2va-bf16.json"),"ref2va-int8":("config.ref2va-int8.json","models-manifest.ref2va-int8.json")}
SAFE_KEYS=("BAO_PROJECT_ID","BAO_SITE_ORIGIN","H3_WORKER_CLIENT_ID","H3_ROOT","H3_APP_DIR","H3_MODEL_PROFILE","H3_ATTENTION_BACKEND")
def envfile(path):
    result={}
    try:
        for line in Path(path).read_text().splitlines():
            line=line.strip()
            if not line or line.startswith("#") or "=" not in line: continue
            key,value=line.split("=",1)
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",key): continue
            try:
                pieces=shlex.split(value,comments=False)
                result[key]=" ".join(pieces) if pieces else ""
            except ValueError: continue
    except OSError: pass
    return result
def sha(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda:f.read(8*1024*1024),b""): h.update(chunk)
    return h.hexdigest()
def safe_values(values):
    return {k:values[k] for k in SAFE_KEYS if k in values}
def effective_value(values,key):
    if key=="H3_MODEL_PROFILE": return values.get(key,"int8")
    if key=="H3_ATTENTION_BACKEND": return values.get(key,"default")
    if key=="H3_ROOT": return values.get(key,"/opt/h3")
    if key=="H3_APP_DIR": return values.get(key,str(Path(values.get("H3_ROOT","/opt/h3"))/"app"))
    return values.get(key)
def service(name,fallback):
    query_verified=False
    try:
        proc=subprocess.run(["systemctl","show",name,"--property=MainPID,ActiveState,EnvironmentFiles,Environment"],capture_output=True,text=True,timeout=8)
        info=dict(line.split("=",1) for line in proc.stdout.splitlines() if "=" in line)
        query_verified=getattr(proc,"returncode",0)==0
    except (OSError,subprocess.TimeoutExpired): info={}
    paths=re.findall(r"(/[^\s;()]+)\s+\(ignore_errors=",info.get("EnvironmentFiles",""))
    paths=paths or [fallback]
    next_env={}
    try:
        for item in shlex.split(info.get("Environment","")):
            if "=" in item:
                key,value=item.split("=",1);next_env[key]=value
    except ValueError: pass
    # systemd EnvironmentFile values override Environment; later files win.
    for path in paths: next_env.update(envfile(path))
    pid=int(info.get("MainPID","0") or 0)
    source="next_start_environment"
    active_values=None
    next_values=safe_values(next_env)
    values=next_values
    mismatches=[]
    if pid:
        try:
            active=dict(item.split("=",1) for item in Path("/proc/%s/environ"%pid).read_bytes().decode().split("\0") if "=" in item)
            active_values=safe_values(active)
            # Never fill a missing active key from a file for a future start.
            values=active_values;source="active_process_environment"
            mismatches=[{"key":key,"activeValue":effective_value(active_values,key),"nextStartValue":effective_value(next_values,key)} for key in SAFE_KEYS if effective_value(active_values,key)!=effective_value(next_values,key)]
        except (OSError,UnicodeError):
            values={};source="active_process_environment_unreadable"
    return {"unit":name,"activeState":info.get("ActiveState","unknown"),"mainPid":pid,"queryVerified":query_verified,"environmentSource":source,"environmentFiles":paths,"values":values,"activeValues":active_values,"nextStartValues":next_values,"environmentMismatches":mismatches}
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hash-models",action="store_true",help="optional full checkpoint SHA; may take time")
    args=parser.parse_args()
    services={}
    for key,name,file in [("worker","bao-h3-outbound-worker.service","worker.env"),("adapter","bao-h3-outbound-adapter.service","worker.env"),("comfy","bao-h3-outbound-comfy.service","worker.env"),("observer","bao-h3-observer.service","observer.env")]:
        services[key]=service(name,"/opt/h3/outbound/"+file)
    values=services["adapter"]["values"]
    root=Path(values.get("H3_ROOT","/opt/h3"))
    app=Path(values.get("H3_APP_DIR",str(root/"app")))
    profile=values.get("H3_MODEL_PROFILE","int8")
    model={"profile":profile,"attentionBackend":values.get("H3_ATTENTION_BACKEND","default"),"configPath":None,"allowedWorkflows":[],"files":[],"errors":[]}
    if profile not in PROFILES: model["errors"].append("unknown_profile")
    else:
        cn,mn=PROFILES[profile];cp=app/cn;mp=app/mn
        model.update(configPath=str(cp),manifestPath=str(mp))
        try:
            config=json.loads(cp.read_text());manifest=json.loads(mp.read_text())
            model.update(configSha256=sha(cp),manifestSha256=sha(mp),allowedWorkflows=config.get("allowed_workflows",["ref2va","fl2va","t2va"]),configuredGenerators={k:config[k] for k in ("fl2va","ref2va","t2va") if k in config})
            models=(root/"models").resolve()
            for f in manifest.get("files",[]):
                path=(models/f["path"]).resolve()
                if not path.is_relative_to(models):
                    model["errors"].append("manifest_path_outside_models");continue
                exists=path.is_file();size=path.stat().st_size if exists else None
                item={"path":f["path"],"optional":bool(f.get("optional")),"exists":exists,"bytes":size,"expectedBytes":f.get("bytes"),"bytesMatch":exists and size==f.get("bytes"),"shaChecked":False,"shaVerified":False}
                if args.hash_models and exists:
                    item["shaChecked"]=True
                    item["shaVerified"]=sha(path)==f.get("sha256")
                model["files"].append(item)
        except (OSError,ValueError,KeyError): model["errors"].append("config_or_manifest_unavailable")
    attention=model["attentionBackend"]
    if attention not in ("default","comfy_kitchen_int8") or (attention!="default" and profile!="ref2va-bf16"):
        model["errors"].append("attention_profile_incompatible")
    pending=[]
    receipt_dir=root/"receipts"/"outbound"
    if receipt_dir.is_dir():
        for path in sorted(receipt_dir.glob("*.json"))[:1000]:
            try:
                value=json.loads(path.read_text())
                if value.get("state") not in ("succeeded","failed","cancelled","complete","uploaded","done"):
                    pending.append({k:value.get(k) for k in ("jobId","projectId","state","providerTaskId","reasonCode")})
            except (OSError,ValueError): continue
    result={"schema":"h3-grok-readonly/v1","readOnly":True,"services":services,"model":model,"pendingReceipts":pending,"receiptScanLimit":1000,"modelLoadOrInferenceRun":False}
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
if __name__=="__main__":main()
