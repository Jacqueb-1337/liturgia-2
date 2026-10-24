'use strict';

const { animate, spring } = require('animejs');

// Identity is local to this window. Duplicate song/verse entries remain unique
// and serialized schedule records never gain animation-only properties.
function createScheduleMotion(list, {view=list.ownerDocument.defaultView,animateFn=animate,springFn=spring}={}) {
  const ids=new WeakMap();
  let sequence=0,initialized=false;
  const active=new Set(),ghosts=new Set();
  const reduce=()=>!!view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  function keyFor(item) {
    if (!item || typeof item!=='object') return '';
    if (!ids.has(item)) ids.set(item,String(++sequence));
    return ids.get(item);
  }
  function stop() {
    for(const instance of active) try {instance?.cancel?.();}catch(_) {}
    active.clear();
    for(const ghost of ghosts) ghost.remove();
    ghosts.clear();
  }
  function capture() {
    const nodes=[...list.querySelectorAll(':scope > .schedule-item[data-motion-id]')];
    const previous=new Map();
    for(const el of nodes) {
      const nested=el.querySelector('.schedule-item-verses');
      previous.set(el.dataset.motionId,{
        node:el,rect:el.getBoundingClientRect(),
        expanded:!!nested?.classList.contains('expanded'),
        nestedHeight:nested?.getBoundingClientRect().height || 0
      });
    }
    // Read positions before stopping an in-flight tween.
    stop();
    return {previous,oldKeys:[...previous.keys()],scrollTop:list.scrollTop};
  }
  function run(node,params,complete) {
    if(reduce())return;
    try {
      let instance;
      instance=animateFn(node,{...params,onComplete:()=>{active.delete(instance);complete?.();}});
      if(instance)active.add(instance);
    }catch(_) {complete?.();}
  }
  function reconcile(snapshot,{animateInitial=false}={}) {
    if(list.scrollTop!==snapshot.scrollTop)list.scrollTop=snapshot.scrollTop;
    const nodes=[...list.querySelectorAll(':scope > .schedule-item[data-motion-id]')];
    const next=new Map(nodes.map(el=>[el.dataset.motionId,el]));
    const oldKeys=snapshot.oldKeys,newKeys=nodes.map(el=>el.dataset.motionId);
    if(!initialized){initialized=true;if(!animateInitial)return;}
    if(reduce())return;
    const changed=oldKeys.length!==newKeys.length||oldKeys.some((key,i)=>newKeys[i]!==key);
    const expansionChanges=[];
    for(const el of nodes){
      const old=snapshot.previous.get(el.dataset.motionId);
      const nested=el.querySelector('.schedule-item-verses');
      if(old && nested && old.expanded !== nested.classList.contains('expanded')){
        expansionChanges.push({el,nested,old,expanded:nested.classList.contains('expanded')});
      }
    }
    const resizingGroup=expansionChanges.length>0 && !changed;
    const limit=30;
    // FLIP: interpolate from each item's previous screen position to its new
    // logical slot. State and keyboard interactions update synchronously.
    if(!resizingGroup && nodes.length<=limit)nodes.forEach((el,i)=>{
      const previous=snapshot.previous.get(el.dataset.motionId);
      if(!previous){
        if(changed)run(el,{opacity:[0,1],y:[11,0],scale:[.975,1],
          delay:Math.min(22*i,110),duration:350,ease:springFn({duration:350,bounce:.12})});
        return;
      }
      const rect=el.getBoundingClientRect(),dx=previous.rect.left-rect.left,dy=previous.rect.top-rect.top;
      if(Math.abs(dx)+Math.abs(dy)<=1)return;
      run(el,{x:[dx,0],y:[dy,0],duration:changed?380:280,
        ease:changed?springFn({duration:380,bounce:.12}):'out(3)'});
    });
    // Animate the *layout* height of a nested verse group rather than
    // instantly switching between display:none and display:block. Surrounding
    // schedule cards flow naturally with the height animation; do not also
    // FLIP them or the two motions would fight each other.
    if(resizingGroup)for(const {nested,old,expanded} of expansionChanges){
      const before=old.nestedHeight;
      const after=expanded?nested.scrollHeight:0;
      if(Math.abs(after-before)<1)continue;
      run(nested,{
        height:[before,after],opacity:expanded?[0,1]:[1,0],
        duration:expanded?340:260,ease:'out(3)'
      },()=>{
        nested.style.removeProperty('height');
        nested.style.removeProperty('opacity');
      });
      if(expanded){
        [...nested.querySelectorAll('.schedule-verse-item')].slice(0,18).forEach((verse,i)=>
          run(verse,{opacity:[0,1],y:[7,0],delay:25+i*20,
            duration:290,ease:springFn({duration:290,bounce:.08})}));
      }
    }
    if(!changed)return;
    const departed=oldKeys.filter(key=>!next.has(key));
    if(departed.length>10)return;
    for(const key of departed){
      const old=snapshot.previous.get(key);
      if(!old||old.rect.width<1||old.rect.height<1)continue;
      const ghost=old.node.cloneNode(true);
      ghost.classList.add('schedule-motion-ghost');
      ghost.removeAttribute('draggable');
      ghost.setAttribute('aria-hidden','true');
      ghost.inert = true;
      ghost.querySelectorAll('[tabindex]').forEach(el=>el.tabIndex=-1);
      ghost.querySelectorAll('[draggable]').forEach(child=>child.removeAttribute('draggable'));
      ghost.style.cssText+=';position:fixed!important;left:'+old.rect.left+'px!important;top:'+old.rect.top+
        'px!important;width:'+old.rect.width+'px!important;height:'+old.rect.height+
        'px!important;margin:0!important;box-sizing:border-box!important;pointer-events:none!important;z-index:9500;';
      list.ownerDocument.body.appendChild(ghost);
      ghosts.add(ghost);
      run(ghost,{opacity:[1,0],y:[0,-10],scale:[1,.96],duration:200,ease:'in(3)'},()=>{
        ghost.remove();ghosts.delete(ghost);
      });
    }
  }
  return {keyFor,capture,reconcile,stop,destroy:stop,get activeCount(){return active.size;}};
}
module.exports={createScheduleMotion};
