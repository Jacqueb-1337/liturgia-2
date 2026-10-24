const {mergeSongStyles,reapplySongOverridesAfterDisplay}=require('../lib/songStyleOverrides');
test('per-option song overrides preserve unmodified style properties',()=>{
 const base={text:{color:'#fff',fontFamily:'Georgia',fontWeight:'bold',textAlign:'right'},reference:{color:'#eee'},global:{lineHeight:1.2,overlayOpacity:0.7}};
 const parsed=mergeSongStyles(base,{styles:{songText:'serialized',global:'g'},enabled:['sg-text-color','ts-global-lineheight']},
  ()=>({color:'#ff0000',fontFamily:'Arial',fontWeight:null,textAlign:'center'}),()=>({lineHeight:1.4,overlayOpacity:0}));
 expect(parsed.text).toEqual({color:'#ff0000',fontFamily:'Georgia',fontWeight:'bold',textAlign:'right'});
 expect(parsed.global).toEqual({lineHeight:1.4,overlayOpacity:0.7});
 expect(base.text.color).toBe('#fff');
});
test('song-specific fields override the target display while inherited fields stay unchanged',()=>{
  const display={text:{color:'#000',fontFamily:'Display Font'},reference:{color:'#bbb'},global:{lineHeight:1.6,overlayOpacity:0.3}};
  const song={text:{color:'#f00',fontFamily:'Song Font'},reference:{color:'#fff'},global:{lineHeight:1.2,overlayOpacity:0.8}};
  const actual=reapplySongOverridesAfterDisplay(display,song,['sg-text-color','ts-global-lineheight']);
  expect(actual.text).toEqual({color:'#f00',fontFamily:'Display Font'});
  expect(actual.global).toEqual({lineHeight:1.2,overlayOpacity:0.3});
  expect(display.text.color).toBe('#000');
});

test('without selected overrides original style remains unchanged',()=>{
 const base={text:{fontWeight:'bold'},global:{overlayOpacity:0.4}};
 expect(mergeSongStyles(base,{styles:{},enabled:[]},()=>({}),()=>({})).text.fontWeight).toBe('bold');
});
