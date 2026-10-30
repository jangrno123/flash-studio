'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {SkillLibrary} = require('./skills');
const {SchemaRegistry} = require('./schema');
const tools = require('./tools');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flash-skill-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const local=path.join(root,'data','skills'),external=path.join(root,'external'),skill=path.join(external,'neutral-guide');
  fs.mkdirSync(local,{recursive:true});fs.mkdirSync(path.join(skill,'references'),{recursive:true});
  const raw='---\nname: neutral-guide\ndescription: "A neutral test"\ncustom-field: preserve-me\n---\n\nOriginal rule.\nKeep this rule.\n';
  fs.writeFileSync(path.join(skill,'SKILL.md'),raw);fs.writeFileSync(path.join(skill,'references','note.md'),'Original reference.');
  const reg=new SchemaRegistry(path.resolve(__dirname,'../../schemas'));
  const lib=new SkillLibrary(local,reg);lib.scan([external,path.join(root,'missing')]);
  const settings=reg.applyDefaults('settings.schema.json',{});settings.skills.extraDirs=[external,path.join(root,'missing')];settings.tools.approval='ask';settings.tools.enableWorkspace=true;
  const ctx={skills:lib,settings,store:{data:path.join(root,'data'),dirs:{workspace:path.join(root,'data','workspace')}},signal:new AbortController().signal};
  return {root,local,external,skill,raw,reg,lib,ctx};
}
test('external skills are searchable and readable without broad filesystem write permission',async t=>{
  const {lib,ctx,skill}=fixture(t);
  const result=JSON.parse((await tools.execute('list_skills',{query:'neutral',limit:1},ctx)).text);
  assert.equal(result.total,1);assert.equal(result.skills[0].source,'external');assert.equal(result.unavailable_dirs.length,1);
  assert.match((await tools.execute('load_skill',{name:'neutral-guide'},ctx)).text,/Keep this rule/);
  assert.equal(tools.resolvePath(path.join(skill,'references','note.md'),ctx,'read'),path.join(skill,'references','note.md'));
  assert.throws(()=>tools.resolvePath(path.join(skill,'references','note.md'),ctx,'write'),/허용되지/);
  assert.equal(lib.get('neutral-guide').source,'external');
});
test('partial external skill edit preserves metadata and other rules, backs up original, and retains approvals',async t=>{
  const {lib,ctx,raw}=fixture(t);
  assert.equal(tools.needsApproval('edit_skill_file',ctx.settings),true);
  const result=JSON.parse((await tools.execute('edit_skill_file',{name:'neutral-guide',path:'SKILL.md',old_text:'Original rule.',new_text:'Updated rule.'},ctx)).text);
  assert.equal(lib.read('neutral-guide').raw,raw.replace('Original rule.','Updated rule.'));
  assert.equal(fs.readFileSync(result.backup,'utf8'),raw);
  assert.rejects(tools.execute('edit_skill_file',{name:'neutral-guide',path:'SKILL.md',old_text:'Original rule.',new_text:'Wrong stale edit.'},ctx),/원문이 없습니다/);
});
test('reference writes require current original, reject path escapes and protect skill identity',t=>{
  const {lib,skill,raw}=fixture(t);
  assert.throws(()=>lib.writeFile('neutral-guide','references/note.md','new'),/expected_content/);
  assert.throws(()=>lib.writeFile('neutral-guide','references/note.md','new','wrong'),/변경됐습니다/);
  lib.writeFile('neutral-guide','references/note.md','new','Original reference.');
  lib.writeFile('neutral-guide','references/extra.md','new file');
  assert.throws(()=>lib.writeFile('neutral-guide','../outside.md','bad'),/폴더 밖/);
  assert.throws(()=>lib.writeFile('neutral-guide','SKILL.md',raw.replace('neutral-guide','different-name'),raw),/name/);
  assert.throws(()=>lib.writeFile('neutral-guide',path.join(skill,'SKILL.md'),'bad'),/상대 경로/);
  assert.equal(lib.read('neutral-guide').raw,raw);
});
test('skill links cannot read or modify files outside the registered skill',t=>{
  const {lib,root,skill,ctx}=fixture(t);
  fs.mkdirSync(path.join(root,'outside'));fs.writeFileSync(path.join(root,'outside','note.md'),'private neutral file');
  fs.symlinkSync(path.join(root,'outside'),path.join(skill,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>lib.readFile('neutral-guide','linked/note.md'),/링크/);
  assert.throws(()=>lib.writeFile('neutral-guide','linked/new.md','bad'),/링크/);
  assert.throws(()=>tools.resolvePath(path.join(skill,'linked','note.md'),ctx,'read'),/링크/);
  assert.equal(fs.readFileSync(path.join(root,'outside','note.md'),'utf8'),'private neutral file');
});
