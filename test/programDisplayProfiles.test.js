const {listProgramDisplays,makeProgramDisplay,updateProgramDisplay,removeProgramDisplay}=require('../lib/programDisplayProfiles');
test('profile belongs to Worship, uses stable id, and stores CSS as base64',()=>{
  const base={otherSetting:1};
  const created=makeProgramDisplay(base,{name:'Bottom Third',styles:{global:'safe-area-y: 0.72; safe-area-h: 0.24;',verseText:'color: #ffffff;'}});
  expect(created.otherSetting).toBe(1);
  expect(listProgramDisplays(created)[0].layout).toMatchObject({width:1920,height:1080,transparent:true});
  const [profile]=listProgramDisplays(created);
  expect(profile.name).toBe('Bottom Third');
  expect(profile.id).toMatch(/^[\w-]{36}$/);
  expect(profile.revision).toBe(1);
  expect(profile.styles.global).toContain('0.72');
  expect(created.programDisplayProfiles[0].styles.global).not.toContain('0.72');
});
test('another Stream can read and update a display only at the expected revision',()=>{
  const first=makeProgramDisplay({}, {name:'Verse Display'});
  const original=listProgramDisplays(first)[0];
  const second=updateProgramDisplay(first,original.id,{expectedRevision:original.revision,styles:{verseText:'color: #ff0000;'}});
  expect(listProgramDisplays(second)[0]).toMatchObject({id:original.id,revision:2,styles:{verseText:'color: #ff0000;'}});
  expect(()=>updateProgramDisplay(second,original.id,{expectedRevision:1,styles:{verseText:'color: #00ff00;'}})).toThrow('changed');
  expect(listProgramDisplays(first)[0].revision).toBe(1);
});
test('a second Stream computer inherits reusable canvas placement and transparency',()=>{
  const first=makeProgramDisplay({}, {name:'Broadcast Lower Third',layout:{x:0,y:0,width:1920,height:1080,transparent:true}});
  const profile=listProgramDisplays(first)[0];
  const modified=updateProgramDisplay(first,profile.id,{expectedRevision:1,layout:{x:210,y:700,width:1350,height:285,transparent:true}});
  const restored=listProgramDisplays(JSON.parse(JSON.stringify(modified)))[0];
  expect(restored.layout).toMatchObject({x:210,y:700,width:1350,height:285,transparent:true});
  expect(restored.revision).toBe(2);
});
test('renaming and deleting profiles leaves other displays untouched',()=>{
  const first=makeProgramDisplay({}, {name:'First'});
  const second=makeProgramDisplay(first,{name:'Second'});
  const [a,b]=listProgramDisplays(second);
  const renamed=updateProgramDisplay(second,a.id,{name:'First Updated',expectedRevision:1});
  expect(listProgramDisplays(renamed).map(x=>x.name)).toEqual(['First Updated','Second']);
  expect(listProgramDisplays(removeProgramDisplay(renamed,a.id))).toMatchObject([{id:b.id,name:'Second'}]);
});
test('rejects bogus CSS property targets and empty names',()=>{
  expect(()=>makeProgramDisplay({},{name:' ',styles:{}})).toThrow('display name');
  expect(()=>makeProgramDisplay({},{name:'X',styles:{unknown:'evil()'}})).toThrow('Unknown style');
});
