'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {EventEmitter}=require('node:events');
const {SchemaRegistry}=require('./schema');const {Store}=require('./store');
const {GrokMedia,validateMedia}=require('./grok-media');const {AnimaLocal}=require('./anima-local');
const {mediaPermission,subscriptionEnvironment,assertSubscriptionConfig}=require('./grok-client');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=','base64');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'flash-media-test-'));const reg=new SchemaRegistry(path.resolve(__dirname,'../../schemas'));const store=new Store(root,reg);store.ensure();const settings=store.getSettings();settings.grok.enabled=true;settings.anima.enabled=true;store.saveSettings(settings);t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'flash-media-test-'));fs.rmSync(root,{recursive:true,force:true});});return store;}
const options=[{optionId:'once',kind:'allow_once'},{optionId:'always',kind:'allow_always'}];
test('media permission approves native media only, never shell, MCP or persistent grants',()=>{
 for(const variant of ['ImageGen','ImageEdit','ImageToVideo','ReferenceToVideo']){const p=mediaPermission({rawInput:{variant}},options);assert.equal(p.allowed,true);assert.equal(p.choice.optionId,'once');}
 for(const variant of ['Bash','MCPTool','ReadFile'])assert.equal(mediaPermission({title:'image_gen',rawInput:{variant}},options).allowed,false);
 assert.equal(mediaPermission({title:'image_gen'},options.slice(1)).allowed,false);
 assert.equal(mediaPermission({title:'image_gen'},options).allowed,true);
});
test('subscription subprocess strips API credentials, preserves parent and pins updater',()=>{
 const source={PATH:'same',XAI_API_KEY:'private',CUSTOM_ACCESS_TOKEN:'private',GROK_DISABLE_AUTOUPDATER:'0'};const clean=subscriptionEnvironment(source);
 assert.equal(clean.XAI_API_KEY,undefined);assert.equal(clean.CUSTOM_ACCESS_TOKEN,undefined);assert.equal(clean.PATH,'same');assert.equal(clean.GROK_DISABLE_AUTOUPDATER,'1');assert.equal(source.XAI_API_KEY,'private');
});
test('subscription mode rejects configured API credentials',t=>{const store=fixture(t);const file=path.join(store.root,'config.toml');fs.writeFileSync(file,'# api_key = "comment"\napi_key = ""\n');assertSubscriptionConfig(store.root);fs.writeFileSync(file,'api_key = "not-a-real-key"\n');assert.throws(()=>assertSubscriptionConfig(store.root),/API/);});
test('successful job survives restart; duplicate requests never regenerate',async t=>{
 const store=fixture(t);let calls=0;
 class Client extends EventEmitter{constructor({cwd}){super();this.cwd=cwd;}async connect(){this.authMethod='grok.com';}async newSession(){return{sessionId:'fixture'};}async prompt(){calls++;const file=path.join(this.cwd,'out.png');fs.writeFileSync(file,png);return{path:file};}close(){}}
 const manager=new GrokMedia(store,{Client});t.after(()=>manager.close());const input={kind:'image',prompt:'fixture'};const job=manager.start(input);const done=await manager.wait(job.id);assert.equal(done.artifacts.length,1);assert.equal(done.authMethod,'grok.com');assert.equal(manager.start(input).id,job.id);
 const restored=new GrokMedia(store,{Client});t.after(()=>restored.close());assert.equal(restored.start(input).status,'succeeded');await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(fs.readFileSync(done.artifacts[0].path).equals(png),true);
});
test('failed jobs are reused without replay; unexpected generation controls rejected',async t=>{
 const store=fixture(t);let calls=0;class Client extends EventEmitter{async connect(){calls++;throw new Error('fixture unavailable');}close(){}}
 const manager=new GrokMedia(store,{Client});t.after(()=>manager.close());const input={kind:'image',prompt:'failure'};const job=manager.start(input);await assert.rejects(manager.wait(job.id),/unavailable/);assert.equal(manager.start(input).id,job.id);await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.throws(()=>manager.start({...input,api_key:'forbidden'}),/스키마/);assert.throws(()=>manager.start({kind:'video',prompt:'x',duration:30}),/스키마/);
});
test('cancelled asynchronous generation never publishes a late success',async t=>{
 const store=fixture(t);let release;const gate=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);
 class Client extends EventEmitter{constructor({cwd}){super();this.cwd=cwd;this.authMethod='grok.com';}async connect(){}async newSession(){return{sessionId:'fixture'};}async prompt(){entered();await gate;const file=path.join(this.cwd,'out.png');fs.writeFileSync(file,png);return{path:file};}close(){}}
 const manager=new GrokMedia(store,{Client});t.after(()=>manager.close());const job=manager.start({kind:'image',prompt:'cancel'});await ready;manager.cancel(job.id);release();await new Promise(r=>setTimeout(r,30));assert.equal(manager.get(job.id).status,'canceled');assert.equal(manager.get(job.id).artifacts.length,0);assert.equal(fs.readdirSync(store.dirs.images).length,0);
});
test('ANIMA queues during training without touching inference; queued cancellation persists',async t=>{
 const store=fixture(t);const manager=new AnimaLocal(store,{training:()=>({active:true})});t.after(()=>manager.close());let calls=0;manager.api=async()=>{calls++;throw new Error('inference must stay off');};manager.startEngine=async()=>{calls++;};
 const input={prompt:'training queue',lora_name:''};const job=await manager.start(input);await manager.tick();assert.equal(manager.get(job.id).status,'queued');assert.equal(calls,0);manager.cancel(job.id);await manager.tick();assert.equal(calls,0);assert.equal(manager.get(job.id).status,'canceled');await assert.rejects(manager.start({...input,reference_images:['ref.png']}));
});
test('invalid content cannot be published as generated media',()=>{assert.throws(()=>validateMedia(Buffer.from('<html>bad</html>'),'image'));assert.throws(()=>validateMedia(Buffer.from('not a video'),'video'));});
test('Grok cannot claim another session media file as its generated output',async t=>{
 const store=fixture(t);const previous=process.env.GROK_HOME;const home=path.join(store.root,'grok-home');fs.mkdirSync(home);process.env.GROK_HOME=home;t.after(()=>{if(previous===undefined)delete process.env.GROK_HOME;else process.env.GROK_HOME=previous;});
 class Client extends EventEmitter{async connect(){this.authMethod='grok.com';}async newSession(){return{sessionId:'owned'};}async prompt(){const other=path.join(home,'unrelated.png');fs.writeFileSync(other,png);return{path:other};}close(){}}
 const manager=new GrokMedia(store,{Client});t.after(()=>manager.close());const job=manager.start({kind:'image',prompt:'untrusted output path'});await assert.rejects(manager.wait(job.id),/결과 파일/);assert.equal(fs.readdirSync(store.dirs.images).length,0);
});
test('video app paths can be read and copied while generation job records stay protected',t=>{
 const store=fixture(t);const ctx={store,settings:store.getSettings()};const {resolvePath}=require('./tools');
 assert.equal(resolvePath('/files/videos/clip.mp4',ctx),path.join(store.data,'videos','clip.mp4'));
 assert.throws(()=>resolvePath(path.join(store.data,'grok','jobs','test.json'),ctx,'write'),/앱이 직접 관리/);
 assert.throws(()=>resolvePath(path.join(store.data,'anima','jobs','test.json'),ctx,'write'),/앱이 직접 관리/);
});
