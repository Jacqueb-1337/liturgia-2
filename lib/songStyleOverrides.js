'use strict';

// Song inheritance is defined per editable control, so unchanged display
// style properties remain untouched. The original styles stay source-of-truth.
const CONTROL_PROPERTIES = {
  'sg-text-color':['text','color'], 'sg-text-font-btn':['text','fontFamily'],
  'sg-text-bold':['text','fontWeight'], 'sg-text-italic':['text','fontStyle'],
  'sg-text-align-left':['text','textAlign'], 'sg-text-letterspacing':['text','letterSpacing'],
  'sg-text-shadow-color':['text','shadowColor'], 'sg-text-shadow-blur':['text','shadowBlur'],
  'sg-text-shadow-x':['text','shadowX'], 'sg-text-shadow-y':['text','shadowY'],
  'sg-text-stroke-color':['text','strokeColor'], 'sg-text-stroke-width':['text','strokeWidth'],
  'sg-reference-color':['reference','color'], 'sg-reference-size':['reference','sizeMultiplier'],
  'sg-reference-font-btn':['reference','fontFamily'],
  'sg-reference-bold':['reference','fontWeight'], 'sg-reference-italic':['reference','fontStyle'],
  'sg-reference-shadow-color':['reference','shadowColor'],
  'sg-reference-shadow-blur':['reference','shadowBlur'],
  'sg-reference-shadow-x':['reference','shadowX'], 'sg-reference-shadow-y':['reference','shadowY'],
  'sg-reference-stroke-color':['reference','strokeColor'],
  'sg-reference-stroke-width':['reference','strokeWidth'],
  'ts-global-overlay':['global','overlayOpacity'],
  'ts-global-blur':['global','bgBlur'],
  'ts-global-vpos-top':['global','verticalPosition'],
  'ts-global-lineheight':['global','lineHeight'],
  'btn-reset-safe-area':['global','safeArea'],
  'sg-inline-lyrics':['global','songInline']
};
function mergeSongStyles(base, overrides, parseStyle, parseGlobal) {
  const result={...base,text:{...(base.text||{})},reference:{...(base.reference||{})},global:{...(base.global||{})}};
  if (!overrides || !Array.isArray(overrides.enabled)) return result;
  const serialized=overrides.styles||{};
  const values={
    text: parseStyle(serialized.songText),
    reference: parseStyle(serialized.songReference),
    global: parseGlobal(serialized.global)
  };
  for(const key of overrides.enabled){
    const entry=CONTROL_PROPERTIES[key];
    if(!entry)continue;
    const [section,field]=entry;
    const val=values[section]?.[field];
    if(val!==undefined)result[section][field]=val;
  }
  return result;
}
function reapplySongOverridesAfterDisplay(displayStyles, songStyles, enabled) {
  if (!Array.isArray(enabled) || !enabled.length) return displayStyles;
  const result={...displayStyles};
  for (const key of enabled) {
    const entry=CONTROL_PROPERTIES[key];
    if (!entry) continue;
    const [section,field]=entry;
    if (!Object.hasOwn(songStyles?.[section] || {},field)) continue;
    if (result[section] === displayStyles[section]) result[section]={...(displayStyles[section]||{})};
    result[section][field]=songStyles[section][field];
  }
  return result;
}
module.exports={CONTROL_PROPERTIES,mergeSongStyles,reapplySongOverridesAfterDisplay};
