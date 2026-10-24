const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {collectUpdateNotes,meaningfulReleaseNotes}=require('../lib/releaseChangelog');
const source=fs.readFileSync(path.join(__dirname,'..','main.js'),'utf8');
const markdown=fs.readFileSync(path.join(__dirname,'..','CHANGELOG.md'),'utf8');
const start=source.indexOf('// Semantic version compare: returns');
const end=source.indexOf('// Expose manual check via IPC',start);
const updaterSource=source.slice(start,end)+'\ncheckForUpdates;';
if(start<0||end<start)throw Error('Updater source markers missing');

async function runCheck({current='6.1.34',latestBody='',pastBody='',rawOk=true}={}) {
 const called=[],releases=[
   {tag_name:'v6.1.36',body:latestBody,assets:[],html_url:'https://github.com/example/release'},
   {tag_name:'v6.1.35',body:pastBody}
 ];
 const fetchFn=async url=>{
   called.push(url);
   if(url.endsWith('/releases/latest'))return {ok:true,json:async()=>releases[0]};
   if(url.includes('/releases?'))return {ok:true,json:async()=>releases};
   if(url.includes('raw.githubusercontent.com/'))return {ok:rawOk,text:async()=>markdown};
   throw Error('Unexpected URL '+url);
 };
 const ctx={
   fetch:fetchFn, console:{warn:jest.fn()},
   app:{getVersion:()=>current},collectUpdateNotes,meaningfulReleaseNotes,
   AbortController, setTimeout, clearTimeout, lastUpdateCheck:null
 };
 const fn=vm.runInNewContext(updaterSource,ctx);
 return {result:await fn(),called};
}
test('actual updater fetches version sections when releases are only GitHub compare links',async()=>{
 const placeholder='**Full Changelog**: https://github.com/example/compare/older...newer';
 const {result,called}=await runCheck({latestBody:placeholder,pastBody:placeholder});
 expect(result.ok).toBe(true);
 expect(result.updateAvailable).toBe(true);
 expect(result.changelog.map(e=>e.version)).toEqual(['v6.1.36','v6.1.35']);
 expect(result.body).toContain('Media tab thumbnail grid');
 expect(result.changelog[1].body).toContain('operator notification center');
 expect(called.some(url=>url.includes('raw.githubusercontent.com/'))).toBe(true);
});
test('an already-authored latest release body is shown as actual notes without fetching raw markdown',async()=>{
 const {result,called}=await runCheck({current:'6.1.35',latestBody:'- feat: release notes delivered',pastBody:'- fix: previous release'});
 expect(result.changelog.map(e=>e.version)).toEqual(['v6.1.36']);
 expect(result.body).toBe('- feat: release notes delivered');
 expect(called.some(url=>url.includes('raw.githubusercontent.com/'))).toBe(false);
});
test('unreachable raw markdown never makes the updater display a comparison URL as its changelog',async()=>{
 const body='**Full Changelog**: https://github.com/example/compare/previous...current';
 const {result}=await runCheck({current:'6.1.35',latestBody:body,rawOk:false});
 expect(result.ok).toBe(true);
 expect(result.updateAvailable).toBe(true);
 expect(result.changelog).toHaveLength(0);
 expect(result.body).toBe('');
});
