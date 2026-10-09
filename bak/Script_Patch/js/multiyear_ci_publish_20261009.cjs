const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto'),{execFileSync}=require('child_process');
assert.equal(process.env.GITHUB_ACTIONS,'true','Publisher is limited to the ephemeral GitHub Actions checkout');
assert(process.env.GITHUB_WORKSPACE&&path.resolve(process.cwd())===path.resolve(process.env.GITHUB_WORKSPACE),'Unexpected publication workspace');
const git=(args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const out=path.resolve(process.env.YEAR_OUTPUT),source='RawData/공정관리/26년 잔여 공사 공정관리_(입력).xlsb',target='RawData/공정관리/YearCache';
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'))),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(manifest.sourceCommit,process.env.YEAR_SOURCE_COMMIT);assert.equal(hash(fs.readFileSync(source)),manifest.sourceSha256);
for(const file of Object.values(manifest.files)){assert(/^[a-f0-9]{64}\/(20\d{2}|unassigned)\.json$/.test(file.path));const b=fs.readFileSync(path.join(out,file.path));assert.equal(b.length,file.bytes);assert.equal(hash(b),file.sha256);}
git(['fetch','origin','main']);const latestSource=git(['log','origin/main','-1','--format=%H','--',source]);assert.equal(latestSource,manifest.sourceCommit,'source changed during generation; cache publication aborted');
// This command is limited to the ephemeral Actions checkout. Preserve any new
// repository commits by building the cache commit from the refreshed remote HEAD.
git(['checkout','-B','year-cache-build','origin/main']);assert.equal(hash(fs.readFileSync(source)),manifest.sourceSha256);
for(const file of Object.values(manifest.files)){const destination=path.join(target,file.path);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(out,file.path),destination);}
fs.copyFileSync(path.join(out,'manifest.json'),path.join(target,'manifest.json'));git(['add','--',target]);
const staged=git(['diff','--cached','--name-only','-z']).split('\0').filter(Boolean);assert(staged.every(p=>p.startsWith(target+'/')),'unexpected staged path');
if(!staged.length){console.log('Verified cache already published.');process.exit(0);}
git(['config','user.name','github-actions[bot]']);git(['config','user.email','41898282+github-actions[bot]@users.noreply.github.com']);git(['commit','-m','Generate verified annual read cache '+manifest.sourceSha256.slice(0,12)]);
// A concurrent XLSB change makes this non-fast-forward push fail. Never force.
git(['push','origin','HEAD:main']);console.log(JSON.stringify({sourceCommit:manifest.sourceCommit,sourceSha256:manifest.sourceSha256,cacheFiles:staged.length}));
