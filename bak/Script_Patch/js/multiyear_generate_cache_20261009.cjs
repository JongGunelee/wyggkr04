const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/PC/AppData/Local/nvm/v25.8.1/node_modules/@playwright/test/node_modules/playwright');
const root=path.resolve(__dirname,'../../..'),inputPath=path.resolve(process.env.YEAR_INPUT||path.join(root,'bak/freeze_patch/20261009_multiyear/source.xlsb'));
const htmlPath=path.resolve(process.env.YEAR_HTML||path.join(root,'091 공정 관리(Full_저장).html'));
const out=path.resolve(process.env.YEAR_OUTPUT||path.join(root,'bak/Script_Patch/tmp/multiyear_cache_20261009'));
const sourcePath='RawData/공정관리/26년 잔여 공사 공정관리_(입력).xlsb',url='https://jonggunelee.github.io/wyggkr/07%20%EC%9E%94%EC%97%AC%20%EA%B3%B5%EC%A0%95%EA%B4%80%EB%A6%AC_%28%EA%B8%B0%EC%88%99%EC%82%AC%20%EB%B0%8F%20%EC%82%AC%ED%83%9D%29_2025-06-00.html';
const input=fs.readFileSync(inputPath),sha=b=>crypto.createHash('sha256').update(b).digest('hex'),blobSha=crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${input.length}\0`),input])).digest('hex');
fs.mkdirSync(out,{recursive:true});
fs.mkdirSync(path.join(root,'bak/Script_Patch/txt'),{recursive:true});
const generationStatus={phase:'browser-launch',startedAt:new Date().toISOString(),inputPath,htmlPath,out,sourceSha256:sha(input),sourceBytes:input.length};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});let data;
 try{
  const context=await browser.newContext({timezoneId:'UTC',viewport:{width:1440,height:900}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));await page.addInitScript(()=>{window.__codexYearCacheDisabled=true;Object.defineProperty(navigator,'webdriver',{get:()=>false});});
  await context.route('**/*',route=>{
   const req=route.request(),u=decodeURIComponent(req.url());if(!['GET','HEAD','OPTIONS'].includes(req.method()))return route.abort();
   if(req.url().startsWith(url))return route.fulfill({status:200,contentType:'text/html',body:fs.readFileSync(htmlPath)});
   if(u.includes(sourcePath.split('/').pop()))return u.includes('api.github.com')?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({sha:blobSha,size:input.length,content:input.toString('base64'),encoding:'base64'})}):route.fulfill({status:200,body:input});
   if(u.includes('/YearCache/'))return route.fulfill({status:404,body:'missing'});return route.continue();
  });
  generationStatus.phase='approved-mapper-load';
  await page.goto(url+'?year-cache-generator=1',{waitUntil:'load',timeout:120000});
  await page.waitForFunction(()=>window.__lastAutoUploadSourceWorkbook&&window.__lastAutoUploadAuxiliaryApplyResult&&window.projectData?.length>0,null,{timeout:120000});
  await page.waitForTimeout(1500);assert.equal(errors.length,0,errors.join('\n'));
  data=await page.evaluate(()=>{
   const wb=window.__lastAutoUploadSourceWorkbook,raw={};
   for(const name of wb.SheetNames)raw[name]=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,defval:'',raw:true});
   const projects=window.DataManager.get(),links=window.projectLinkStore.loadProjectLinkMap();
   return {projects,works:window.workItems||[],milestones:window.milestones||[],links:links instanceof Map?Object.fromEntries(links):links,raw,sourceSheetNames:wb.SheetNames,sourceVbaBytes:wb.vbaraw?.length||0,sourceDate1904:!!wb.Workbook?.WBProps?.date1904,browserMappingVersion:window.YearContext?.VERSION,carryKey:window.YearContext?.carryKey,headerMapping:window.__lastProjectHeaderInfo||null};
  });
  await context.close();
 }finally{await browser.close();}
generationStatus.phase='source-and-normalized-row-validation';
generationStatus.normalizedCounts={projects:data.projects.length,work:data.works.length,milestones:data.milestones.length};
generationStatus.rawCounts=Object.fromEntries(Object.entries(data.raw).map(([name,rows])=>[name,rows.length]));
const legacyMapper=sha(fs.readFileSync(htmlPath))==='9e608f7fd8733f2b97b4b69ce89064f83fe745618ff119beae198f745c32f048';
const yearApi=legacyMapper?require('./multiyear_context_legacy_20261124.cjs'):require('./multiyear_context_20261009.js');
const mappingVersion='year-context-20261009-v2';
assert.equal(yearApi.VERSION,mappingVersion,'generator classification version');
assert.equal(data.browserMappingVersion,mappingVersion,'approved HTML classification version');
assert.equal(data.carryKey,legacyMapper?undefined:'Codex_Year_Carryover_V1','approved mapper capability');
assert.equal(yearApi.carryKey,data.carryKey);
assert.equal(typeof yearApi.classification,'function');assert.equal(typeof yearApi.accountingYear,'function');
const operatingYear=Number(process.env.YEAR_OPERATING_YEAR||new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',year:'numeric'}).format(new Date()));
assert(Number.isInteger(operatingYear)&&operatingYear>=2000&&operatingYear<=2199,'invalid operating year');
const years=[...new Set([...data.projects.flatMap(p=>[...yearApi.membership(p,operatingYear)]),...data.milestones.map(m=>yearApi.asYear(m.date)).filter(Boolean)])].sort((a,b)=>b-a),sourceSha256=sha(input);
const normalizeText=v=>String(v??'').trim(),rawProject=data.raw[data.sourceSheetNames[0]],headers=rawProject[0],codeColumn=headers.findIndex(v=>/유지관리번호/.test(normalizeText(v))),settlementColumn=headers.findIndex(v=>/정산.*월/.test(normalizeText(v))),poColumn=headers.findIndex(v=>normalizeText(v)==='PO금액'),progressColumn=headers.findIndex(v=>/진척률|진행률/.test(normalizeText(v))),startColumn=headers.findIndex(v=>/작업기간/.test(normalizeText(v))),endColumn=startColumn+1;assert(codeColumn>=0&&settlementColumn>=0&&poColumn>=0&&progressColumn>=0&&startColumn>=0);
const rawRows=rawProject.slice(2).filter(r=>normalizeText(r[codeColumn])),normalizedByCode=new Map(data.projects.map(p=>[String(p.maintenanceCode),p]));
generationStatus.rawProjectCount=rawRows.length;
generationStatus.unmappedMaintenanceCodes=rawRows.filter(row=>!normalizedByCode.has(normalizeText(row[codeColumn]))).map(row=>normalizeText(row[codeColumn]));
assert.equal(normalizedByCode.size,data.projects.length,'unique maintenance codes');assert.equal(rawRows.length,data.projects.length,'all project rows mapped');
generationStatus.phase='independent-raw-classification';
// Independent oracle reads original worksheet cells, never the context API.
// Decode the original workbook's own 1900/1904 date system without the API.
const pendingText=/^(작업중|작업 중|미정산|정산 대기|정산대기)$/;
const serialDate=value=>{const epoch=data.sourceDate1904?Date.UTC(1904,0,1):Date.UTC(1899,11,30),date=new Date(epoch+Math.floor(value)*86400000);return Number.isFinite(date.getTime())?date:null;};
function rawDateYears(value){
 if(value instanceof Date)return Number.isFinite(value.getTime())?[value.getUTCFullYear()]:[];
 if(typeof value==='number'){if(value>=1900&&value<=2200&&Number.isInteger(value))return [value];const date=serialDate(value);return date?[date.getUTCFullYear()]:[];}
 return [...normalizeText(value).matchAll(/(?:^|[^\d])(20\d{2})(?:[-./년]|$)/g)].map(m=>Number(m[1]));
}
function rawSettlement(value){
 const text=normalizeText(value);
 if(!text||pendingText.test(text))return {kind:'blank',year:null};
 if(value instanceof Date)return Number.isFinite(value.getTime())?{kind:'valid',year:value.getUTCFullYear()}:{kind:'invalid',year:null};
 if(typeof value==='number'){const date=serialDate(value);return date?{kind:'valid',year:date.getUTCFullYear()}:{kind:'invalid',year:null};}
 const compact=text.match(/^(20\d{2})(\d{2})$/),match=compact||text.match(/^(20\d{2})[-./](\d{1,2})(?:[-./](\d{1,2}))?$/);
 if(!match||Number(match[2])<1||Number(match[2])>12)return {kind:'invalid',year:null};
 if(match[3]&&(Number(match[3])<1||Number(match[3])>new Date(Date.UTC(Number(match[1]),Number(match[2]),0)).getUTCDate()))return {kind:'invalid',year:null};
 return {kind:'valid',year:Number(match[1])};
}
const workYearsByCode=new Map();
for(const [name,rows]of Object.entries(data.raw)){
 if(!/^work$/i.test(name)||!rows.length)continue;
 const workHeaders=rows[0],ownerColumn=workHeaders.findIndex(v=>/유지관리번호|project.?id/i.test(normalizeText(v))),dateColumn=workHeaders.findIndex(v=>/작업일|작업날짜|work.?date/i.test(normalizeText(v)));
 assert(ownerColumn>=0&&dateColumn>=0,'work owner/date columns');
 for(const row of rows.slice(1)){const code=normalizeText(row[ownerColumn]);if(!code)continue;const set=workYearsByCode.get(code)||new Set();rawDateYears(row[dateColumn]).forEach(y=>set.add(y));workYearsByCode.set(code,set);}
}
const carryColumn = headers.findIndex(v => normalizeText(v) === 'Codex_Year_Carryover_V1');
assert(!legacyMapper || carryColumn < 0,'legacy mapper cannot preserve a carryover column');
function rawCarryYear(row) {
 const value = carryColumn < 0 ? '' : normalizeText(row[carryColumn]);
 if (!value) return null;
 // Fail closed if the raw sheet and the approved mapper disagree about a ledger.
 assert(/^[A-Za-z0-9_-]{1,30000}$/.test(value),'invalid carryover encoding');
 const record = JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
 assert([1,2].includes(record.version) && Number.isInteger(record.base) && record.base>=2000 && record.base<=2199 && Array.isArray(record.events),'invalid carryover record');
 let year=record.base, reserved=false;
 const ids=new Set();
 for (const e of record.events) {
  assert(e.id && !ids.has(e.id) && e.from===year && Number.isInteger(e.to) && e.to>=2000 && e.to<=2199,'invalid carryover sequence');
  ids.add(e.id);
  if (e.action==='move') {
   assert(record.version===2&&!reserved&&e.to!==year,'invalid selected-year movement');
   year=e.to;
   continue;
  }
  assert(e.to===year+1,'invalid adjacent carryover');
  if (e.action==='reserve') { assert(!reserved); reserved=true; }
  else {
   assert(reserved && ['cancel','settle','transfer'].includes(e.action)); reserved=false;
   if(e.action==='transfer'||(e.action==='settle'&&e.settledYear===e.to))year=e.to;
  }
 }
 return year;
}
function rawClassification(row){
 const month=rawSettlement(row[settlementColumn]),completed=Number(normalizeText(row[progressColumn]).replace(/[% ,]/g,''))>=100;
 if(month.kind==='valid')return {kind:'settled',year:month.year,completed};
 if(month.kind==='invalid')return {kind:'unknown',year:null,completed};
 const set=new Set(workYearsByCode.get(normalizeText(row[codeColumn]))||[]),start=rawDateYears(row[startColumn])[0],end=rawDateYears(row[endColumn])[0];
 if(start&&end&&end>=start&&end-start<=100)for(let year=start;year<=end;year++)set.add(year);else{if(start)set.add(start);if(end)set.add(end);}
 const carry=rawCarryYear(row);
 if(carry!==null)return {kind:'open',year:carry,completed};
 const schedule=[...set].filter(y=>Number.isInteger(y)&&y>=2000&&y<=2199);
 if(schedule.length&&schedule.every(y=>y>operatingYear))return {kind:'planned',year:Math.min(...schedule),completed};
 if(legacyMapper)return {kind:'open',year:operatingYear,completed};
 const year=end||start||(schedule.length?Math.min(...schedule):null);
 return year>=2000&&year<=2199?{kind:'open',year,completed}:{kind:'unknown',year:null,completed};
}
const zero=()=>({count:0,po:0}),aggregate=()=>({settled:{...zero(),byYear:{}},open:{...zero(),unfinished:zero(),unsettledComplete:zero()},planned:{...zero(),byYear:{}},unknown:zero()});
function addCount(target,po){target.count++;target.po+=po;}
function addClassification(target,classification,po){
 const entry=target[classification.kind];assert(entry,'unknown classification kind');addCount(entry,po);
 if(classification.kind==='open')addCount(classification.completed?entry.unsettledComplete:entry.unfinished,po);
 if(entry.byYear){entry.byYear[classification.year]??=zero();addCount(entry.byYear[classification.year],po);}
}
const financialChecks={},settledFinancialChecks={},classificationChecks=aggregate(),rawFinancialChecks={},rawClassificationChecks=aggregate();
for(const project of data.projects){
 const classification=yearApi.classification(project,operatingYear),key=yearApi.accountingYear(project,operatingYear)??'unknown',po=Number(project.poAmount)||0;
 financialChecks[key]??=zero();addCount(financialChecks[key],po);addClassification(classificationChecks,classification,po);
 if(classification.kind==='settled'){settledFinancialChecks[classification.year]??=zero();addCount(settledFinancialChecks[classification.year],po);}
}
for(const row of rawRows){
 const classification=rawClassification(row),key=classification.year??'unknown',po=Number(row[poColumn])||0,normalized=normalizedByCode.get(normalizeText(row[codeColumn]));
 assert(normalized,'unmapped source project '+normalizeText(row[codeColumn]));
 assert.equal(normalizeText(normalized.customFields?.[data.carryKey]),carryColumn<0?'':normalizeText(row[carryColumn]),'source carryover field preservation');
 assert(!yearApi.carryState?.(normalized)?.invalid,'invalid carryover ledger');
 assert.deepEqual(yearApi.classification(normalized,operatingYear),classification,'raw/normalized year classification: '+normalizeText(row[codeColumn]));
 assert.equal(Number(normalized.poAmount)||0,po,'raw/normalized project PO: '+normalizeText(row[codeColumn]));
 rawFinancialChecks[key]??=zero();addCount(rawFinancialChecks[key],po);addClassification(rawClassificationChecks,classification,po);
}
assert.deepEqual(financialChecks,rawFinancialChecks,'independent raw financial attribution');
assert.deepEqual(classificationChecks,rawClassificationChecks,'independent raw status attribution');
assert.equal(rawRows.reduce((n,r)=>n+(Number(r[poColumn])||0),0),data.projects.reduce((n,p)=>n+(Number(p.poAmount)||0),0),'raw PO total');
const rawSource={};for(const [name,rows]of Object.entries(data.raw))rawSource[name]=rows.map(row=>{const copy=row.slice();while(copy.length&&String(copy[copy.length-1]??'').trim()==='')copy.pop();return copy;});
generationStatus.phase='verified-cache-serialization';
const carryoverVersion=data.projects.some(p=>yearApi.carryState?.(p)?.record?.version===2)?2:1;
const manifest={...(legacyMapper?{}:{carryoverVersion}),sourceInternalIdMax:Math.max(0,...data.projects.map(p=>String(p.id)!==String(p.maintenanceCode)?Number(p.id)||0:0)),sourceMaintenanceCodes:data.projects.map(p=>String(p.maintenanceCode)),schemaVersion:1,mappingVersion,generatedForOperatingYear:operatingYear,classificationVersion:mappingVersion,sourcePath,sourceCommit:process.env.YEAR_SOURCE_COMMIT||null,sourceBlobSha:blobSha,sourceSha256,sourceBytes:input.length,htmlSha256:sha(fs.readFileSync(htmlPath)),generatedAt:new Date().toISOString(),years,counts:{projects:data.projects.length,work:data.works.length,milestones:data.milestones.length,dependencies:data.projects.reduce((n,p)=>n+(p.dependsOn?.length||0),0),webLinks:Object.values(data.links).filter(Boolean).length},financialChecks,settledFinancialChecks,classificationChecks,rawFinancialChecks,rawClassificationChecks,files:{},currentRawCounts:Object.fromEntries(Object.entries(data.raw).map(([n,r])=>[n,r.length])),vbaBytes:data.sourceVbaBytes};
const modelFor=projects=>{const ids=new Set(projects.map(p=>String(p.id))),codes=new Set(projects.map(p=>String(p.maintenanceCode)));return {schemaVersion:1,sourceSha256,projects,works:data.works.filter(w=>ids.has(String(w.projectId))),links:Object.fromEntries(Object.entries(data.links).filter(([id])=>ids.has(id))),milestones:[],raw:{...rawSource,[data.sourceSheetNames[0]]:[...rawProject.slice(0,2),...rawRows.filter(r=>codes.has(normalizeText(r[codeColumn])))]}};};
for(const y of [...years,'unassigned']){const projects=y==='unassigned'?data.projects.filter(p=>yearApi.membership(p,operatingYear).size===0):data.projects.filter(p=>yearApi.membership(p,operatingYear).has(y)),model=modelFor(projects);model.year=y;model.mappingVersion=mappingVersion;model.generatedForOperatingYear=operatingYear;model.milestones=data.milestones.filter(m=>y==='unassigned'?yearApi.asYear(m.date)===null:yearApi.asYear(m.date)===y);
for(const [name,rows]of Object.entries(model.raw)){if(name===data.sourceSheetNames[0])continue;const h=rows[0]||[],code=h.findIndex(v=>/유지관리번호/.test(normalizeText(v)));if(code>=0){const codes=new Set(projects.map(p=>String(p.maintenanceCode)));model.raw[name]=[h,...rows.slice(1).filter(r=>codes.has(normalizeText(r[code])))];}else if(/마일스톤|milestone/i.test(name)){model.raw[name]=[h,...rows.slice(1).filter(r=>{const dateIndex=h.findIndex(v=>/날짜|date|일자/i.test(normalizeText(v))),nameIndex=h.findIndex(v=>/마일스톤|name/i.test(normalizeText(v)));if(dateIndex<0||nameIndex<0)return false;const normalized=data.milestones.find(m=>normalizeText(m.name)===normalizeText(r[nameIndex]));return normalized&&(y==='unassigned'?yearApi.asYear(normalized.date)===null:yearApi.asYear(normalized.date)===y);})];}}
const content=Buffer.from(JSON.stringify(model)),file=String(y)+'.json';manifest.files[y]={path:sourceSha256+'/'+file,sha256:sha(content),bytes:content.length,projects:projects.length,work:model.works.length,milestones:model.milestones.length,dependencies:projects.reduce((n,p)=>n+(p.dependsOn?.length||0),0),webLinks:Object.values(model.links).filter(Boolean).length};fs.mkdirSync(path.join(out,sourceSha256),{recursive:true});fs.writeFileSync(path.join(out,sourceSha256,file),content);
}
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));const reportPath=path.join(root,'bak/Script_Patch/txt/multiyear_cache_generation_'+sourceSha256.slice(0,8)+'_'+Date.now()+'.json');fs.writeFileSync(reportPath,JSON.stringify({out,manifest,ok:true},null,2));console.log(JSON.stringify({out,reportPath,sourceSha256,years,counts:manifest.counts,financialChecks}));
})().catch(e=>{
 const reportPath=path.join(root,'bak/Script_Patch/txt/multiyear_cache_generation_failed_'+sha(input).slice(0,8)+'_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex')+'.json');
 const error={name:e.name,message:e.message,stack:e.stack,code:e.code,actual:e.actual,expected:e.expected,operator:e.operator};
 fs.mkdirSync(path.dirname(reportPath),{recursive:true});
 fs.writeFileSync(reportPath,JSON.stringify({ok:false,...generationStatus,finishedAt:new Date().toISOString(),error},null,2),{flag:'wx'});
 console.error(e);console.error(JSON.stringify({ok:false,reportPath,phase:generationStatus.phase,sourceSha256:sha(input)}));process.exitCode=1;
});
