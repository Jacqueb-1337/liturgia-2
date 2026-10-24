'use strict';
const { drag, motionValue, styleEffect } = require('motion');
const { spring } = require('animejs');
const POSITION_KEY = 'liturgia.notificationPill.position.v1';
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));

function createNotificationPillMotion({view,storage,bar,button,panel,pillIcon,pillCount,shine,canAnimate,play,stopMotion,dragFn=drag}) {
  let unread = null, badgeEpoch = 0, shineTimer = null, dragStop = null;
  let suppressClick = false, open = false, destroyed = false, effectStop = null;
  let pointerStartX = null, clearClickTimer = null;
  function onPointerDown(event) {
    if (open || event.button !== 0) return;
    pointerStartX = event.clientX;
  }
  function onPointerMove(event) {
    if (pointerStartX != null && Math.abs(event.clientX - pointerStartX) > 7)
      suppressClick = true;
  }
  function onPointerUp() {
    pointerStartX = null;
    if (clearClickTimer != null) view?.clearTimeout?.(clearClickTimer);
    if (suppressClick) clearClickTimer = view?.setTimeout?.(() => {
      suppressClick = false;
      clearClickTimer = null;
    }, 350);
  }
  bar.addEventListener('pointerdown', onPointerDown, true);
  bar.addEventListener('pointermove', onPointerMove, true);
  bar.addEventListener('pointerup', onPointerUp, true);
  bar.addEventListener('pointercancel', onPointerUp, true);
  let fraction = 1;
  try { const value = storage?.getItem(POSITION_KEY);
    if (value != null && Number.isFinite(Number(value))) fraction = clamp(Number(value),0,1);
  } catch (_) {}
  const x = motionValue(0);
  const travel = () => Math.max(0, (view?.innerWidth || 1280) - button.offsetWidth - 36);
  // Establish the saved transform BEFORE registering Motion's render effect.
  // Otherwise the first styleEffect frame can render at x=0 and the pill
  // remains at the right edge until the first pointer interaction.
  x.set(-travel() * (1 - fraction));
  bar.style.transform = 'translate3d(' + x.get() + 'px,0,0)';
  try { if (view?.document) effectStop = styleEffect(bar, {x}); } catch (_) {}
  function alignPanel() {
    if (!view?.innerWidth || !bar.getBoundingClientRect) return;
    const width = Math.min(410,view.innerWidth - 24);
    const b = button.getBoundingClientRect(), host = bar.getBoundingClientRect();
    const left = clamp(b.right - width,12,view.innerWidth - width - 12);
    panel.style.left = (left - host.left) + 'px';
    panel.style.right = 'auto';
    panel.style.transformOrigin = clamp(b.left + b.width / 2 - left,18,width - 18) + 'px 100%';
  }
  function applyPosition() {
    const position = -travel() * (1-fraction);
    x.set(position);
    // Setting this synchronously is important before the first animation
    // frame, particularly when restoring a persisted position at startup.
    bar.style.transform = 'translate3d(' + position + 'px,0,0)';
    alignPanel();
  }
  function savePosition() {
    fraction = clamp(1 + x.get() / Math.max(1,travel()),0,1);
    try {storage?.setItem(POSITION_KEY,String(fraction));} catch (_) {}
  }
  function stopShine() {
    if (shineTimer != null) {view?.clearInterval?.(shineTimer);shineTimer=null;}
    stopMotion(shine);
  }
  function sweep() {
    if (destroyed || open || unread <= 0 || !canAnimate() || button.hidden) return;
    play(shine,{opacity:[0,.36,.36,0],x:[-85,button.offsetWidth+90],
      duration:1050,ease:'inOut(2)'});
  }
  function manageShine() {
    stopShine();
    if (!open && unread > 0 && canAnimate() && !destroyed)
      shineTimer = view?.setInterval?.(sweep,8500);
  }
  function expand(fromWidth) {
    stopMotion(button);
    button.style.removeProperty('width');
    const target = button.getBoundingClientRect().width;
    if (!canAnimate() || fromWidth <= 0 || Math.abs(target-fromWidth) < 1) {applyPosition();return;}
    button.style.width = fromWidth + 'px';
    applyPosition();
    play(button,{width:[fromWidth,target],duration:460,
      onUpdate:()=>{ if(!bar.classList.contains('is-dragging')) applyPosition(); },
      ease:spring({duration:460,bounce:.2})},()=>{
      button.style.removeProperty('width');applyPosition();
      if (!open) { stopDrag(); startDrag(); }
    });
  }
  function showBadge() {
    const epoch=++badgeEpoch, compact=button.getBoundingClientRect().width;
    pillCount.hidden=false;
    pillCount.style.opacity='0';
    pillCount.style.transform='scale(.1)';
    expand(compact);
    play(pillCount,{opacity:[0,1],scale:[.1,1.17,1],delay:155,
      duration:415,ease:spring({duration:415,bounce:.2})},()=>{
      if(epoch!==badgeEpoch)return;
      pillCount.style.removeProperty('opacity');
      pillCount.style.removeProperty('transform');
    });
  }
  function hideBadge() {
    const epoch=++badgeEpoch, from=button.getBoundingClientRect().width;
    if(!canAnimate()){pillCount.hidden=true;applyPosition();return;}
    play(pillCount,{opacity:[1,0],scale:[1,.16],duration:190,ease:'in(3)'},()=>{
      if(epoch!==badgeEpoch)return;
      pillCount.hidden=true;
      expand(from);
    });
  }
  function syncUnread(count) {
    const previous=unread; unread=count;
    button.classList.toggle('has-unread',count>0);
    button.setAttribute('aria-label',count>0
      ? count+' unread '+(count===1?'notification':'notifications')+'. Open notification center'
      : open?'Close notifications':'Open notifications');
    if(previous===null) {
      pillCount.hidden=count===0;
      applyPosition(); // pill text/badge and hidden state now have final size
    }
    else if(count>0 && previous===0) showBadge();
    else if(count===0 && previous>0) hideBadge();
    manageShine();
    // A saved x-position must be correct on this very render, not when
    // the first click or a later animation eventually forces a layout.
    if(!bar.classList.contains('is-dragging')) applyPosition();
  }
  function onNew() {
    if(!canAnimate()||open)return;
    play(pillIcon,{rotate:[-19,14,-5,0],scale:[.91,1.11,1],
      duration:480,ease:'out(3)'});
  }
  function startDrag() {
    if(destroyed||open||dragStop||!view?.PointerEvent||typeof dragFn!=='function')return;
    try {
      const reduced = !!view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      dragStop=dragFn(bar,{
        constraints:{left:-travel(),right:0,top:0,bottom:0},
        elastic:reduced?0:{left:.12,right:.12,top:.68,bottom:.18},
        snapToOrigin:'y',momentum:!reduced,
        transition:{power:.23,timeConstant:210,bounceStiffness:650,bounceDamping:29},
        onStart:()=>bar.classList.add('is-dragging'),
        onMove:alignPanel,
        onEnd:()=>{
          bar.classList.remove('is-dragging');
          savePosition();
          suppressClick=true;
          if(clearClickTimer != null) view?.clearTimeout?.(clearClickTimer);
          clearClickTimer = view?.setTimeout?.(()=>{suppressClick=false;clearClickTimer=null;},350);
        },
        onTransitionEnd:()=>{savePosition();alignPanel();}
      });
    } catch (_) {dragStop=null;}
  }
  function stopDrag() {
    if(dragStop){dragStop();dragStop=null;}
    bar.classList.remove('is-dragging');
  }
  function setOpen(value) {
    open=!!value;
    if(open){stopDrag();alignPanel();}else startDrag();
    manageShine();
  }
  function onResize() {
    if(destroyed)return;
    if(!open)stopDrag();
    applyPosition();
    if(!open)startDrag();
  }
  function consumeDragClick(){if(!suppressClick)return false;suppressClick=false;return true;}
  view?.addEventListener?.('resize',onResize);
  const sizeObserver = view?.ResizeObserver
    ? new view.ResizeObserver(() => {
      if(destroyed || bar.classList.contains('is-dragging')) return;
      // Keep the launcher anchored as its unread badge grows, without
      // tearing down and re-registering the drag gesture each animation frame.
      applyPosition();
    })
    : null;
  sizeObserver?.observe(button);
  const firstFrame = view?.requestAnimationFrame?.(() => {
    if (!destroyed) applyPosition();
  });
  applyPosition();startDrag();
  function destroy(){
    destroyed=true;stopShine();stopDrag();stopMotion(pillCount);
    view?.removeEventListener?.('resize',onResize);
    sizeObserver?.disconnect();
    if(firstFrame != null) view?.cancelAnimationFrame?.(firstFrame);
    if(clearClickTimer != null) view?.clearTimeout?.(clearClickTimer);
    bar.removeEventListener('pointerdown',onPointerDown,true);
    bar.removeEventListener('pointermove',onPointerMove,true);
    bar.removeEventListener('pointerup',onPointerUp,true);
    bar.removeEventListener('pointercancel',onPointerUp,true);
    if(typeof effectStop==='function')effectStop();
  }
  return {syncUnread,setOpen,onNew,alignPanel,consumeDragClick,destroy,sweep,
    getPositionFraction:()=>fraction};
}
module.exports={createNotificationPillMotion,POSITION_KEY};
