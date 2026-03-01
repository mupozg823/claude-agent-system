// ── renderer-core.js ── Character drawing, background, particles, active screens
import { S, C, FLOORS, DESKS, AT, SEASON_BG, TOOL_COLORS } from './state.js';
import { getGameCalendar, getDayPhase } from './utils.js';

// ── Canvas dimension helpers ──
export function cW(){return S.pixiApp?S.pixiApp.screen.width:(document.getElementById('c').width/S.dpr)}
export function cH(){return S.pixiApp?S.pixiApp.screen.height:(document.getElementById('c').height/S.dpr)}

// ── PixiJS v8 init ──
export async function initPixi(){
  const container=document.querySelector('.scene');
  if(!container||!window.PIXI){console.warn('PixiJS not available');initCanvasFallback();return}
  try{
    S.pixiApp=new PIXI.Application();
    await S.pixiApp.init({resizeTo:container,background:0xD4C8A0,antialias:false,
      resolution:Math.min(window.devicePixelRatio||1,2),autoDensity:true,
      preference:'webgl',powerPreference:'high-performance'});
    PIXI.TextureStyle.defaultOptions.scaleMode='nearest';
    const old=container.querySelector('canvas');if(old)old.remove();
    S.pixiApp.canvas.style.cssText='display:block;width:100%;height:100%';
    container.appendChild(S.pixiApp.canvas);
    ['bg','weather','desks','agents','particles','hud','effects'].forEach(name=>{
      S.L[name]=new PIXI.Container();S.L[name].label=name;S.pixiApp.stage.addChild(S.L[name]);
    });
    S.bgSprite=new PIXI.Sprite();S.L.bg.addChild(S.bgSprite);
    for(let i=0;i<8;i++){
      const ac=document.createElement('canvas');ac.width=80;ac.height=120;S.agentCanvases.push(ac);
      const sp=new PIXI.Sprite();sp.anchor.set(0.5,0.5);S.agentSprites.push(sp);S.L.agents.addChild(sp);
    }
    for(let i=0;i<8;i++){
      const dc=document.createElement('canvas');dc.width=50;dc.height=50;S.deskCanvases.push(dc);
      const sp=new PIXI.Sprite();sp.visible=false;S.deskSprites.push(sp);S.L.desks.addChild(sp);
    }
    S.hudCanvas=document.createElement('canvas');S.hudCanvas.width=240;S.hudCanvas.height=80;
    S.hudCx=S.hudCanvas.getContext('2d');
    S.hudSprite=new PIXI.Sprite();S.L.hud.addChild(S.hudSprite);
    S.buf=document.createElement('canvas');S.buf.width=80;S.buf.height=120;
    S.cx=S.buf.getContext('2d');S.dpr=1;
    S.pixiApp.ticker.maxFPS=30;S.pixiReady=true;
    console.log('PixiJS v8 initialized',S.pixiApp.screen.width+'x'+S.pixiApp.screen.height);
  }catch(e){console.error('PixiJS init failed:',e);initCanvasFallback()}
}

function initCanvasFallback(){
  S.pixiReady=false;const cv=document.getElementById('c');
  const mainCx=cv.getContext('2d');
  function resize(){
    const rect=cv.parentElement.getBoundingClientRect();
    if(rect.width<10||rect.height<10)return;
    S.dpr=Math.min(window.devicePixelRatio||1,2);
    cv.width=rect.width*S.dpr;cv.height=rect.height*S.dpr;
    cv.style.width=rect.width+'px';cv.style.height=rect.height+'px';
    S.buf=document.createElement('canvas');S.buf.width=cv.width;S.buf.height=cv.height;
    S.cx=S.buf.getContext('2d');S.cx.setTransform(S.dpr,0,0,S.dpr,0,0);S.bg=null;
  }
  resize();window.addEventListener('resize',resize);window._mainCx=mainCx;
}
export function initCanvas(){return initPixi()}

// ── Character drawing ──
export function drawCh(px,py,type,wf,dir,work,bub,ag){
  const cx=S.cx,fr=S.fr,c=C[type]||C.agent,s=S.P;
  const OL='#1A1A0A',SK='#FFD8B0';
  const idle=ag&&ag.st==='idle',mood=ag?ag.mood:0;
  const flip=dir<0;
  if(flip){cx.save();cx.translate(px*2,0);cx.scale(-1,1)}
  if(work){
    const bob=Math.sin(fr*.15)*.5,y=py+bob;
    const tL=Math.sin(fr*.5)*1,tR=Math.sin(fr*.5+3.14)*1;
    cx.fillStyle=c.s;cx.fillRect(px-5*s,y+3*s+tL,2*s,2.5*s);cx.fillRect(px+3*s,y+3*s+tR,2*s,2.5*s);
    cx.fillStyle=SK;cx.fillRect(px-5*s,y+5*s+tL,2*s,s);cx.fillRect(px+3*s,y+5*s+tR,2*s,s);
    cx.fillStyle=OL;cx.fillRect(px-4*s-1,y+1.5*s-1,8*s+2,4*s+2);
    cx.fillStyle=c.s;cx.fillRect(px-4*s,y+1.5*s,8*s,4*s);
    cx.fillStyle='#FFF';cx.fillRect(px-1.5*s,y+1.5*s,3*s,s);
    cx.fillStyle=OL;cx.fillRect(px-5*s-1,y-5.5*s-1,10*s+2,7*s+2);
    cx.fillStyle=SK;cx.fillRect(px-5*s,y-5.5*s,10*s,7*s);
    cx.fillStyle='#FFAA8840';cx.fillRect(px-4.5*s,y-1*s,2*s,1.5*s);cx.fillRect(px+2.5*s,y-1*s,2*s,1.5*s);
    cx.fillStyle=OL;cx.fillRect(px-5.5*s-1,y-7*s-1,11*s+2,3.5*s+2);
    cx.fillStyle=c.h;cx.fillRect(px-5.5*s,y-7*s,11*s,3.5*s);
    cx.fillRect(px-5.5*s,y-4*s,2*s,2.5*s);cx.fillRect(px+3.5*s,y-4*s,2*s,2.5*s);
    if(fr%100<97){
      cx.fillStyle='#FFF';cx.fillRect(px-3.5*s,y-3.5*s,3*s,2.5*s);cx.fillRect(px+.5*s,y-3.5*s,3*s,2.5*s);
      cx.fillStyle='#000';cx.fillRect(px-2.5*s,y-3*s,1.8*s,1.8*s);cx.fillRect(px+1.2*s,y-3*s,1.8*s,1.8*s);
      cx.fillStyle='#FFF';cx.fillRect(px-2.2*s,y-3*s,s*.6,s*.6);cx.fillRect(px+1.5*s,y-3*s,s*.6,s*.6);
    }else{cx.fillStyle='#000';cx.fillRect(px-3.5*s,y-2.5*s,3*s,s*.5);cx.fillRect(px+.5*s,y-2.5*s,3*s,s*.5)}
    cx.fillStyle='#CC6644';cx.fillRect(px-s*.5,y,fr%60<10?2*s:s,s*.5);
    drawAccessory(px,y,type,s,true);
    if(ag&&ag.wt>60){const sw=((fr*2)%25);cx.globalAlpha=1-sw/25;cx.fillStyle='#88CCFF';
      cx.fillRect(px+5*s,y-5*s+sw*.5,s*.5,s*.8);cx.globalAlpha=1}
    drawWorkFx(px,y,type,s);
    if(flip)cx.restore();
    drawStatusIcon(px+6.5*s,y-7*s,'gear');
    if(bub)drawBub(px,y-9*s,bub);
    drawNameTag(px,py+8*s,c);return;
  }
  // Standing/Walking
  const bounce=Math.sin(wf*.3)*1,y=py+bounce;
  const walk=ag&&ag.st==='walk';
  const step=walk?Math.sin(wf*.35)*2:Math.sin(wf*.08)*.5;
  cx.fillStyle='#00000020';cx.fillRect(px-4*s,y+8.5*s,8*s,1.5*s);
  cx.fillStyle=OL;
  cx.fillRect(px-2.5*s,y+7*s+(step>0?-s*.5:0),2*s,2*s);
  cx.fillRect(px+.5*s,y+7*s+(step<0?-s*.5:0),2*s,2*s);
  cx.fillStyle=c.p;
  cx.fillRect(px-2.3*s,y+7.2*s+(step>0?-s*.5:0),1.6*s,1.5*s);
  cx.fillRect(px+.7*s,y+7.2*s+(step<0?-s*.5:0),1.6*s,1.5*s);
  cx.fillStyle=OL;cx.fillRect(px-2.5*s-1,y+5.5*s-1,5*s+2,2*s+2);
  cx.fillStyle=c.p;cx.fillRect(px-2.5*s,y+5.5*s,5*s,2*s);
  cx.fillStyle=OL;cx.fillRect(px-3.5*s-1,y+2*s-1,7*s+2,4*s+2);
  cx.fillStyle=c.s;cx.fillRect(px-3.5*s,y+2*s,7*s,4*s);
  cx.fillStyle='#FFF';cx.fillRect(px-1.2*s,y+2*s,2.4*s,s*.8);
  let armL=step*.3,armR=-step*.3;
  if(idle&&mood===1){armL=-2;armR=-2}
  if(idle&&mood===3){armR=-3}
  cx.fillStyle=OL;
  cx.fillRect(px-4.5*s-1,y+2.5*s+armL-1,1.5*s+2,3.5*s+2);
  cx.fillRect(px+3*s-1,y+2.5*s+armR-1,1.5*s+2,3.5*s+2);
  cx.fillStyle=c.s;
  cx.fillRect(px-4.5*s,y+2.5*s+armL,1.5*s,3.5*s);cx.fillRect(px+3*s,y+2.5*s+armR,1.5*s,3.5*s);
  cx.fillStyle=SK;
  cx.fillRect(px-4.5*s,y+5.5*s+armL,1.5*s,1.2*s);cx.fillRect(px+3*s,y+5.5*s+armR,1.5*s,1.2*s);
  if(idle&&mood===3){
    cx.fillStyle='#FFF';cx.fillRect(px+3.5*s,y+2*s+armR,2*s,2.5*s);
    cx.fillStyle='#8B6914';cx.fillRect(px+3.5*s,y+2*s+armR,2*s,.4*s);
    cx.fillStyle='#6B3A1A';cx.fillRect(px+3.7*s,y+2.4*s+armR,1.6*s,1.6*s);
    if(fr%40<25){cx.globalAlpha=.4;cx.fillStyle='#FFF';
      cx.fillRect(px+4*s,y+1.2*s+armR-Math.sin(fr*.1)*s,s*.4,s*.7);
      cx.fillRect(px+4.5*s,y+.8*s+armR-Math.cos(fr*.12)*s,s*.3,s*.5);cx.globalAlpha=1}
  }
  let headOff=0;if(idle&&mood===2)headOff=Math.sin(fr*.04)*2;
  cx.fillStyle=OL;cx.fillRect(px-5*s-1+headOff,y-5*s-1,10*s+2,7*s+2);
  cx.fillStyle=SK;cx.fillRect(px-5*s+headOff,y-5*s,10*s,7*s);
  cx.fillStyle='#FFAA8840';cx.fillRect(px-4.5*s+headOff,y-.5*s,2*s,1.5*s);cx.fillRect(px+2.5*s+headOff,y-.5*s,2*s,1.5*s);
  cx.fillStyle=OL;cx.fillRect(px-5.5*s-1+headOff,y-6.5*s-1,11*s+2,3.5*s+2);
  cx.fillStyle=c.h;cx.fillRect(px-5.5*s+headOff,y-6.5*s,11*s,3.5*s);
  cx.fillRect(px-5.5*s+headOff,y-3.5*s,2*s,2.5*s);cx.fillRect(px+3.5*s+headOff,y-3.5*s,2*s,2.5*s);
  const blk=fr%180>=176;
  if(!blk&&!(idle&&mood===4)){
    const ex=dir>0?s*.3:dir<0?-s*.3:0;
    cx.fillStyle='#FFF';cx.fillRect(px-3.5*s+headOff,y-3*s,3*s,2.5*s);cx.fillRect(px+.5*s+headOff,y-3*s,3*s,2.5*s);
    cx.fillStyle='#222';cx.fillRect(px-2.5*s+ex+headOff,y-2.5*s,1.8*s,1.8*s);cx.fillRect(px+1.2*s+ex+headOff,y-2.5*s,1.8*s,1.8*s);
    cx.fillStyle='#FFF';cx.fillRect(px-2.2*s+ex+headOff,y-2.5*s,s*.6,s*.6);cx.fillRect(px+1.5*s+ex+headOff,y-2.5*s,s*.6,s*.6);
  }else if(idle&&mood===4){
    cx.fillStyle='#FFF';cx.fillRect(px-3.5*s+headOff,y-2.5*s,3*s,1.2*s);cx.fillRect(px+.5*s+headOff,y-2.5*s,3*s,1.2*s);
    cx.fillStyle='#222';cx.fillRect(px-2.5*s+headOff,y-2*s,1.5*s,s*.8);cx.fillRect(px+1.2*s+headOff,y-2*s,1.5*s,s*.8);
  }else{cx.fillStyle='#222';cx.fillRect(px-3*s+headOff,y-1.8*s,2.5*s,s*.4);cx.fillRect(px+.5*s+headOff,y-1.8*s,2.5*s,s*.4)}
  cx.fillStyle='#CC6644';
  if(idle&&mood===4){cx.fillRect(px-.5*s+headOff,y+.5*s,s*1.2,s*.8)}
  else if(idle&&mood===1){cx.fillRect(px-s+headOff,y+.5*s,2*s,s*.3);cx.fillRect(px-.5*s+headOff,y+.7*s,s,s*.2)}
  else if(walk){cx.fillRect(px-.3*s+headOff,y+.5*s,s*.6,s*.4)}
  else{cx.fillRect(px-.5*s+headOff,y+.5*s,s,s*.4)}
  drawAccessory(px+headOff,y,type,s,false);
  if(ag&&ag.compFx>0){cx.globalAlpha=ag.compFx/20;cx.fillStyle='#FFD080';cx.fillRect(px-6*s,y-7*s,12*s,16*s);cx.globalAlpha=1}
  if(flip)cx.restore();
  if(idle){if(mood===4)drawStatusIcon(px+6*s,y-7*s,'zzz');else if(mood===0)drawStatusIcon(px+6*s,y-7*s,'idle')}
  drawNameTag(px,y+9*s,c);
}

function drawAccessory(px,y,type,s,sitting){
  const cx=S.cx,fr=S.fr;
  switch(type){
    case 'bash':cx.fillStyle='#333';cx.fillRect(px-5.8*s,y-4*s,1.2*s,3*s);cx.fillRect(px+4.6*s,y-4*s,1.2*s,3*s);cx.fillStyle='#555';cx.fillRect(px-4*s,y-7.5*s,8*s,s*.8);break;
    case 'reader':cx.fillStyle='#8B6914';cx.fillRect(px-4*s,y-3.2*s,3.2*s,s*.4);cx.fillRect(px+.8*s,y-3.2*s,3.2*s,s*.4);cx.fillRect(px-4*s,y-3.2*s,s*.3,2.5*s);cx.fillRect(px-.8*s,y-3.2*s,s*.3,2.5*s);cx.fillRect(px+.8*s,y-3.2*s,s*.3,2.5*s);cx.fillRect(px+3.7*s,y-3.2*s,s*.3,2.5*s);cx.fillRect(px-.8*s,y-2.5*s,1.6*s,s*.3);break;
    case 'writer':cx.fillStyle='#CC2244';cx.fillRect(px-5*s,y-7.5*s,10*s,2*s);cx.fillStyle='#FF4466';cx.fillRect(px-5*s,y-7.5*s,10*s,s*.6);cx.fillRect(px-s*.5,y-8*s,s,s);break;
    case 'finder':cx.fillStyle='#556B2F';cx.fillRect(px-5.5*s,y-7*s,11*s,1.5*s);cx.fillRect(px-6*s,y-5.8*s,3*s,s);break;
    case 'mcp':cx.fillStyle='#44DDAA';cx.fillRect(px-.2*s,y-8.5*s,s*.4,2*s);cx.fillStyle='#00FF88';cx.fillRect(px-.5*s,y-9*s,s,s);if(fr%30<15){cx.fillStyle='#00FF8860';cx.fillRect(px-s,y-9.5*s,2*s,2*s)}break;
    case 'agent':if(!sitting){cx.fillStyle='#CC3300';cx.fillRect(px-.5*s,y+2.8*s,s,2.5*s);cx.fillRect(px-.8*s,y+2.5*s,1.6*s,s*.6)}break;
    case 'web':cx.fillStyle='#333';cx.fillRect(px-5.8*s,y-4*s,1.2*s,2.5*s);cx.fillStyle='#444';cx.fillRect(px-6.5*s,y-2*s,2*s,1.5*s);cx.fillRect(px-6.5*s,y-2*s,s*.3,2*s);break;
    case 'serena':cx.fillStyle='#FFD700';cx.fillRect(px+3*s,y-6*s,2.5*s,1.5*s);cx.fillStyle='#FFA500';cx.fillRect(px+3.8*s,y-6*s,s*.8,1.5*s);break;
  }
}

function drawNameTag(px,y,c){
  const cx=S.cx;const nm=c.l;
  cx.font='bold 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",sans-serif';cx.textAlign='center';
  const nw=cx.measureText(nm).width+14,tx=px-nw/2,ty=y,th=16,r3=4;
  cx.fillStyle='#00000018';cx.beginPath();
  cx.moveTo(tx+r3+1,ty+1);cx.lineTo(tx+nw-r3+1,ty+1);cx.arc(tx+nw-r3+1,ty+r3+1,r3,-Math.PI/2,0);
  cx.lineTo(tx+nw+1,ty+th-r3+1);cx.arc(tx+nw-r3+1,ty+th-r3+1,r3,0,Math.PI/2);
  cx.lineTo(tx+r3+1,ty+th+1);cx.arc(tx+r3+1,ty+th-r3+1,r3,Math.PI/2,Math.PI);
  cx.lineTo(tx+1,ty+r3+1);cx.arc(tx+r3+1,ty+r3+1,r3,Math.PI,3*Math.PI/2);cx.fill();
  cx.fillStyle=c.p;cx.beginPath();const r2=4;
  cx.moveTo(tx+r2,ty);cx.lineTo(tx+nw-r2,ty);cx.arc(tx+nw-r2,ty+r2,r2,-Math.PI/2,0);
  cx.lineTo(tx+nw,ty+th-r2);cx.arc(tx+nw-r2,ty+th-r2,r2,0,Math.PI/2);
  cx.lineTo(tx+r2,ty+th);cx.arc(tx+r2,ty+th-r2,r2,Math.PI/2,Math.PI);
  cx.lineTo(tx,ty+r2);cx.arc(tx+r2,ty+r2,r2,Math.PI,3*Math.PI/2);cx.fill();
  cx.strokeStyle='#00000030';cx.lineWidth=1;cx.stroke();
  cx.fillStyle='#FFFFFFEE';cx.fillText(nm,px,y+12);
}

function drawWorkFx(px,y,type,s){
  const cx=S.cx,fr=S.fr;
  cx.font='bold 9px monospace';cx.textAlign='center';const phase=fr*.12;
  switch(type){
    case 'bash':['$_','>_','OK','#!','~~'].forEach((ch,i)=>{const fy=((fr*2+i*25)%70);cx.globalAlpha=1-fy/70;cx.fillStyle='#44DD66';cx.fillText(ch,px+(Math.sin(i*2.1)*3-1)*s,y-8*s-fy*.4)});break;
    case 'reader':for(let i=0;i<2;i++){const fy=((fr*1.5+i*40)%60);cx.globalAlpha=.8-fy/75;cx.fillStyle='#FFF';cx.fillRect(px+(i*2-1)*5*s,y-9*s-fy*.3,3*s,3.5*s);cx.fillStyle='#6688CC';for(let j=0;j<3;j++)cx.fillRect(px+(i*2-1)*5*s+s*.3,y-8.5*s+j*s-fy*.3,2.2*s,s*.25)}break;
    case 'writer':['</>','{;}','fn(','//!','==='].forEach((ch,i)=>{const fy=((fr*2.2+i*20)%65);cx.globalAlpha=1-fy/65;cx.fillStyle=['#FF6699','#FFAA22','#88BBFF','#44DD66','#CC88FF'][i];cx.fillText(ch,px+(Math.sin(i*1.7)*3.5)*s,y-8*s-fy*.35)});break;
    case 'finder':['??','>>','**','..','!!'].forEach((ch,i)=>{const fy=((fr*1.8+i*22)%60);cx.globalAlpha=1-fy/60;cx.fillStyle='#44AA88';cx.fillText(ch,px+(Math.cos(i*1.4)*3)*s,y-8*s-fy*.35)});break;
    case 'mcp':for(let i=0;i<4;i++){const ang=phase+i*Math.PI/2,r=(3+Math.sin(fr*.08+i)*1.5)*s;cx.globalAlpha=.5+Math.sin(fr*.1+i)*.3;cx.fillStyle='#44DDAA';cx.fillRect(px+Math.cos(ang)*r-s*.4,y-8*s+Math.sin(ang)*r-s*.4,s*.8,s*.8)}cx.globalAlpha=1;cx.fillStyle='#00FF88';cx.fillRect(px-s*.5,y-8.5*s,s,s);break;
    case 'agent':['>>','>>','>>'].forEach((_,i)=>{const fx=((fr*3+i*30)%80)-40;cx.globalAlpha=1-Math.abs(fx)/40;cx.fillStyle='#AA88FF';cx.fillRect(px+fx*.5,y-8*s-i*2*s,s*1.5,s*.8)});break;
    case 'web':['@','://','GET','200','www'].forEach((ch,i)=>{const fy=((fr*2+i*18)%55);cx.globalAlpha=1-fy/55;cx.fillStyle='#FF88AA';cx.fillText(ch,px+(Math.sin(i*2.3)*3)*s,y-8*s-fy*.35)});break;
    case 'serena':cx.fillStyle='#B8860B';cx.globalAlpha=.7;cx.fillRect(px-s*.3,y-11*s,s*.6,4*s);
      [[-2,-2],[2,-2.5],[-1.5,-3.5],[1.5,-4],[0,-5]].forEach(([bx,by],i)=>{cx.fillStyle=['#44AA44','#228B22','#66CC66','#44AA44','#88DD88'][i];cx.globalAlpha=.5+Math.sin(fr*.06+i)*.3;cx.fillRect(px+bx*s,y-11*s+by*s,s*1.2,s*1.2)});break;
  }
  cx.globalAlpha=1;
}

function drawStatusIcon(x,y,type){
  const cx=S.cx,fr=S.fr;
  if(type==='gear'){const gfr=fr*.08;cx.fillStyle='#FFD080';for(let i=0;i<6;i++){const a=gfr+i*Math.PI/3,r=3.5;cx.fillRect(x+Math.cos(a)*r-1.5,y+Math.sin(a)*r-1.5,3,3)}cx.fillStyle='#8B6914';cx.fillRect(x-2,y-2,4,4)}
  else if(type==='zzz'){cx.font='bold 10px monospace';cx.textAlign='left';const z=((fr>>4)%3);cx.globalAlpha=.6;cx.fillStyle='#8888CC';if(z>=0)cx.fillText('z',x,y);if(z>=1)cx.fillText('z',x+5,y-6);if(z>=2)cx.fillText('Z',x+9,y-13);cx.globalAlpha=1}
  else if(type==='idle'){cx.fillStyle='#AAAAAA';const dp=(fr>>3)%4;for(let i=0;i<3;i++){cx.globalAlpha=i<=dp?.6:.15;cx.fillRect(x+i*4,y,2,2)}cx.globalAlpha=1}
}

function drawBub(x,y,t){
  const cx=S.cx;
  const d=t.length>16?t.slice(0,16)+'\u2026':t;
  cx.font='bold 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",sans-serif';
  const tw=cx.measureText(d).width,w=Math.max(tw+16,44),h=22,bx2=x-w/2,by=y-h,r=5;
  cx.fillStyle='#1A1A0A30';cx.fillRect(bx2+1,by+1,w,h);
  cx.fillStyle='#FFF6E8';cx.beginPath();
  cx.moveTo(bx2+r,by);cx.lineTo(bx2+w-r,by);cx.arc(bx2+w-r,by+r,r,-Math.PI/2,0);
  cx.lineTo(bx2+w,by+h-r);cx.arc(bx2+w-r,by+h-r,r,0,Math.PI/2);
  cx.lineTo(bx2+r,by+h);cx.arc(bx2+r,by+h-r,r,Math.PI/2,Math.PI);
  cx.lineTo(bx2,by+r);cx.arc(bx2+r,by+r,r,Math.PI,3*Math.PI/2);cx.fill();
  cx.strokeStyle='#C4A06A';cx.lineWidth=1.5;cx.stroke();
  cx.fillStyle='#D4A032';cx.fillRect(bx2+2,by,w-4,2);
  cx.fillStyle='#FFF6E8';cx.beginPath();cx.moveTo(x-3,y);cx.lineTo(x+3,y);cx.lineTo(x,y+4);cx.fill();
  cx.strokeStyle='#C4A06A';cx.lineWidth=1;cx.beginPath();cx.moveTo(x-3,y);cx.lineTo(x,y+4);cx.lineTo(x+3,y);cx.stroke();
  cx.textAlign='center';cx.textBaseline='middle';cx.fillStyle='#8B6F47';cx.fillText(d,x,y-h/2);cx.textBaseline='alphabetic';
}

// ── Background cache ──
export function buildBg(w,h){
  if(w<10||h<10)return;
  const o=document.createElement('canvas');o.width=w*S.dpr;o.height=h*S.dpr;
  const g=o.getContext('2d');g.setTransform(S.dpr,0,0,S.dpr,0,0);
  const fy=h*.55,s=S.P;
  const _cal=getGameCalendar(),_seasonBg=SEASON_BG[_cal.season]||SEASON_BG['\uBD04'];
  S.currentSeason=_cal.season;
  const fl=S.viewMode==='floor'?FLOORS[S.currentFloor]:null;
  const sb=fl?{wall:fl.colors.wall,floor:fl.colors.floor,sky:_seasonBg.sky,accent:fl.colors.accent}:_seasonBg;
  const wallGrad=g.createLinearGradient(0,0,0,fy);
  wallGrad.addColorStop(0,sb.wall[0]);wallGrad.addColorStop(.7,sb.wall[1]);wallGrad.addColorStop(1,sb.wall[2]);
  g.fillStyle=wallGrad;g.fillRect(0,0,w,fy);
  g.fillStyle='#E8D4B020';for(let x=0;x<w;x+=8)g.fillRect(x,0,1,fy);
  g.fillStyle='#00000015';g.fillRect(0,fy-6,w,8);
  g.fillStyle='#6B4E00';g.fillRect(0,fy-3,w,7);g.fillStyle='#8B6914';g.fillRect(0,fy-3,w,5);
  g.fillStyle='#A08030';g.fillRect(0,fy-3,w,2);
  for(let x=0;x<w;x+=24)for(let y=fy+4;y<h;y+=12){
    const shade=((x/24+y/12)%3===0)?0:((x/24+y/12)%3===1)?1:2;
    g.fillStyle=sb.floor[shade];g.fillRect(x,y,24,12);g.fillStyle='#FFFFFF06';g.fillRect(x,y,24,1);
  }
  // Window
  const wx=w*.42,wW=110,wH=58;
  g.fillStyle='#8B6914';g.fillRect(wx-4,6,wW+8,wH+8);
  const skyG=g.createLinearGradient(wx,10,wx,10+wH);skyG.addColorStop(0,sb.sky[0]);skyG.addColorStop(.6,sb.sky[1]);skyG.addColorStop(1,sb.sky[2]);
  g.fillStyle=skyG;g.fillRect(wx,10,wW,wH);
  g.fillStyle='#FFFFFFCC';[[15,18,16],[45,12,12],[75,20,14]].forEach(([cx2,cy,r])=>{g.beginPath();g.arc(wx+cx2,10+cy,r,0,Math.PI*2);g.fill();g.beginPath();g.arc(wx+cx2+r*.7,10+cy+2,r*.7,0,Math.PI*2);g.fill()});
  g.strokeStyle='#C8A882';g.lineWidth=3;g.strokeRect(wx,10,wW,wH);g.lineWidth=2;
  g.beginPath();g.moveTo(wx+wW/2,10);g.lineTo(wx+wW/2,10+wH);g.stroke();
  g.beginPath();g.moveTo(wx,10+wH/2);g.lineTo(wx+wW,10+wH/2);g.stroke();
  g.fillStyle='#FFE0A080';g.fillRect(wx-2,8,6,wH+6);g.fillRect(wx+wW-4,8,6,wH+6);
  // Clock
  g.fillStyle='#FFF';g.beginPath();g.arc(w*.15,28,14,0,Math.PI*2);g.fill();
  g.strokeStyle='#8B6914';g.lineWidth=3;g.stroke();
  g.fillStyle='#8B6914';g.font='bold 5px sans-serif';g.textAlign='center';
  ['12','3','6','9'].forEach((n,i)=>{const a=i*Math.PI/2-Math.PI/2;g.fillText(n,w*.15+Math.cos(a)*10,28+Math.sin(a)*10+2)});
  // Best agent plaque
  g.fillStyle='#4A3020';g.fillRect(w*.73-2,8,44,36);g.fillStyle='#FFE8C0';g.fillRect(w*.73,10,40,32);
  g.fillStyle='#CC3300';g.font='bold 9px sans-serif';g.textAlign='center';g.fillText('BEST',w*.73+20,24);g.fillText('AGENT',w*.73+20,35);
  g.fillStyle='#CC0000';g.beginPath();g.arc(w*.73+20,12,3,0,Math.PI*2);g.fill();
  // Lights
  [[w*.25,5],[w*.75,5]].forEach(([lx,ly])=>{g.fillStyle='#FFD080';g.fillRect(lx-8,ly,16,4);g.fillStyle='#FFF8E0';g.fillRect(lx-6,ly+4,12,3);const lg=g.createLinearGradient(lx,ly+7,lx,ly+45);lg.addColorStop(0,'#FFD08020');lg.addColorStop(1,'#FFD08000');g.fillStyle=lg;g.beginPath();g.moveTo(lx-8,ly+7);g.lineTo(lx+8,ly+7);g.lineTo(lx+25,ly+45);g.lineTo(lx-25,ly+45);g.closePath();g.fill()});
  // Plants
  [[w*.04,fy-10],[w*.96,fy-10]].forEach(([px2,py])=>{g.fillStyle='#AA5533';g.fillRect(px2-6,py+8,12,10);g.fillStyle='#CC6633';g.fillRect(px2-7,py+6,14,4);g.fillStyle='#228B22';[[-6,-8],[0,-14],[6,-8],[-3,-11],[3,-11]].forEach(([lx,ly])=>{g.beginPath();g.arc(px2+lx,py+ly,5,0,Math.PI*2);g.fill()});g.fillStyle='#44AA44';[[-4,-6],[2,-12],[5,-6]].forEach(([lx,ly])=>{g.beginPath();g.arc(px2+lx,py+ly,4,0,Math.PI*2);g.fill()})});
  // Floor-specific decorations
  if(S.viewMode==='floor'){
    const _dfy=fy,_ds=s;
    if(S.currentFloor===0){const rx=w*.08,ry=_dfy-32*_ds/5;g.fillStyle='#2A2A3A';g.fillRect(rx,ry,12*_ds/5,28*_ds/5);g.fillStyle='#1A1A2A';g.fillRect(rx+1,ry+1,10*_ds/5,26*_ds/5);for(let si=0;si<5;si++){const sy2=ry+3+si*5*_ds/5;g.fillStyle=si<3?'#44DD66':'#333';g.fillRect(rx+2,sy2,8*_ds/5,3*_ds/5);if(si<3){g.fillStyle='#00FF0060';g.fillRect(rx+2,sy2,1.5,1.5)}}g.strokeStyle='#55555580';g.lineWidth=1;g.beginPath();g.moveTo(rx+6*_ds/5,ry+28*_ds/5);g.lineTo(rx+6*_ds/5,_dfy+8);g.stroke();const rx2=w*.92;g.fillStyle='#2A2A3A';g.fillRect(rx2,ry+4,10*_ds/5,24*_ds/5);g.fillStyle='#1A1A2A';g.fillRect(rx2+1,ry+5,8*_ds/5,22*_ds/5);for(let si=0;si<4;si++){g.fillStyle='#333844';g.fillRect(rx2+2,ry+7+si*5*_ds/5,6*_ds/5,3*_ds/5);g.fillStyle=Math.random()>.5?'#44AAFF40':'#FF444440';g.fillRect(rx2+2,ry+7+si*5*_ds/5,1,1)}}
    else if(S.currentFloor===1){const bx2=w*.06,by2=_dfy-30*_ds/5;g.fillStyle='#6B4E30';g.fillRect(bx2,by2,14*_ds/5,30*_ds/5);g.fillStyle='#5A3E20';g.fillRect(bx2+1,by2+1,12*_ds/5,28*_ds/5);const bookColors=['#CC3333','#3366CC','#44AA44','#CC8833','#8844AA','#DD6688'];for(let bi=0;bi<3;bi++){const sy2=by2+3+bi*9*_ds/5;g.fillStyle='#4A3018';g.fillRect(bx2+1,sy2+7*_ds/5,12*_ds/5,1.5);for(let bj=0;bj<4;bj++){g.fillStyle=bookColors[(bi*4+bj)%bookColors.length];const bw=2+Math.random()*1.5;g.fillRect(bx2+2+bj*3*_ds/5,sy2,bw*_ds/5,7*_ds/5)}}const mx=w*.93,my=_dfy-16;g.strokeStyle='#8866CC';g.lineWidth=2;g.beginPath();g.arc(mx,my,6,0,Math.PI*2);g.stroke();g.strokeStyle='#6644AA';g.lineWidth=2.5;g.beginPath();g.moveTo(mx+4,my+4);g.lineTo(mx+9,my+9);g.stroke();g.fillStyle='#8866CC20';g.beginPath();g.arc(mx,my,5,0,Math.PI*2);g.fill()}
    else if(S.currentFloor===2){const mx2=w*.05,my2=_dfy-28*_ds/5,mw=16*_ds/5,mh=12*_ds/5;g.fillStyle='#5A4A3A';g.fillRect(mx2-1,my2-1,mw+2,mh+2);g.fillStyle='#2244AA';g.fillRect(mx2,my2,mw,mh);g.fillStyle='#44AA44';g.fillRect(mx2+2,my2+2,4*_ds/5,5*_ds/5);g.fillRect(mx2+8*_ds/5,my2+1,4*_ds/5,4*_ds/5);g.fillRect(mx2+12*_ds/5,my2+3,3*_ds/5,4*_ds/5);const dots=[[3,3],[10,2],[13,5]];dots.forEach(([dx,dy])=>{if(Math.sin(S.fr*.1+dx*2)>.3){g.fillStyle='#FF884080';g.beginPath();g.arc(mx2+dx*_ds/5,my2+dy*_ds/5,1.5,0,6.28);g.fill()}});const ax=w*.93,ay=_dfy-20;g.fillStyle='#888';g.fillRect(ax,ay+6,2,10);g.strokeStyle='#AAA';g.lineWidth=1.5;g.beginPath();g.arc(ax+1,ay+4,6,Math.PI*.8,Math.PI*1.8);g.stroke();g.fillStyle='#FF884060';g.beginPath();g.arc(ax+1,ay+4,2,0,6.28);g.fill();for(let si=1;si<=3;si++){const a2=.3+Math.sin(S.fr*.06+si)*.15;g.strokeStyle=`rgba(255,136,68,${a2})`;g.lineWidth=.8;g.beginPath();g.arc(ax+1,ay+4,4+si*3,-.6,-.2);g.stroke()}}
  }
  // Desks
  DESKS.filter(d=>S.viewMode==='building'||d.floor===S.currentFloor).forEach((d)=>{
    const di=DESKS.indexOf(d),x=d.x*w,dy=fy+2,ds=s*.8,ac=C[AT[di]];
    g.fillStyle='#1A1A0A';g.fillRect(x-8*s-1,dy-1,16*s+2,2.5*ds+2);
    g.fillStyle='#A07848';g.fillRect(x-8*s,dy,16*s,2.5*ds);
    g.fillStyle='#8B683030';for(let i=0;i<3;i++)g.fillRect(x-7*s,dy+i*ds*.8+ds*.2,14*s,1);
    g.fillStyle='#B8884020';g.fillRect(x-8*s,dy,16*s,1);
    g.fillStyle='#8B6914';g.fillRect(x-7*s,dy+2.5*ds,1.2*s,6*s);g.fillRect(x+5.8*s,dy+2.5*ds,1.2*s,6*s);
    g.fillStyle='#1A1A0A';g.fillRect(x-4*s-1,dy-8*s-1,8*s+2,7.5*s+2);
    g.fillStyle='#333';g.fillRect(x-4*s,dy-8*s,8*s,7.5*s);
    g.fillStyle='#0A0A1A';g.fillRect(x-3.2*s,dy-7.5*s,6.4*s,5.8*s);
    g.fillStyle=ac.s;g.fillRect(x-4*s,dy-8*s,8*s,1.5);
    g.fillStyle='#555';g.fillRect(x-1*s,dy-.5*s,2*s,1*s);g.fillRect(x-2*s,dy+.3*s,4*s,.5*s);
    g.fillStyle='#444';g.fillRect(x-3*s,dy+1*s,6*s,1.8*s);g.fillStyle='#555';g.fillRect(x-2.8*s,dy+1.2*s,5.6*s,1.4*s);
    g.fillStyle='#666';for(let r=0;r<3;r++)for(let k=0;k<6;k++)g.fillRect(x-2.6*s+k*s*.9,dy+1.3*s+r*s*.45,s*.7,s*.35);
    g.fillStyle='#555';g.fillRect(x+3.5*s,dy+1.5*s,1.2*s,1.8*s);g.fillStyle='#666';g.fillRect(x+3.6*s,dy+1.6*s,1*s,.6*s);
    g.fillStyle='#444';g.fillRect(x-3*s,dy+4*s,6*s,1.2*s);g.fillStyle='#555';g.fillRect(x-2.8*s,dy+3.8*s,5.6*s,.4*s);
    g.fillStyle='#3A3A3A';g.fillRect(x-2.5*s,dy+1.5*s,.6*s,2.5*s);g.fillRect(x+1.9*s,dy+1.5*s,.6*s,2.5*s);
    g.fillStyle='#666';g.fillRect(x-.3*s,dy+5.2*s,.6*s,2.5*s);
    g.fillStyle='#333';g.beginPath();g.arc(x-2*s,dy+8*s,.8*s,0,Math.PI*2);g.fill();g.beginPath();g.arc(x+2*s,dy+8*s,.8*s,0,Math.PI*2);g.fill();g.beginPath();g.arc(x,dy+8*s,.8*s,0,Math.PI*2);g.fill();
    if(di%3===0){g.fillStyle='#F5E6C8';g.fillRect(x+5*s,dy-s*.5,1.5*s,2*s);g.fillStyle='#8B6914';g.fillRect(x+5*s,dy-s*.5,1.5*s,.4*s);g.fillStyle='#6B3A1A';g.fillRect(x+5.2*s,dy-.1*s,1.1*s,1.2*s)}
    else if(di%3===1){g.fillStyle='#FFF';g.fillRect(x+5*s,dy-s*.8,2*s,1.5*s);g.fillStyle='#EEE';g.fillRect(x+5.1*s,dy-s*.6,2*s,1.5*s);g.fillStyle='#DDD';g.fillRect(x+5.2*s,dy-s*.4,2*s,1.5*s)}
    else{g.fillStyle='#FFEE88';g.fillRect(x+5*s,dy-s*.5,1.8*s,1.8*s);g.fillStyle='#88BB44';g.fillRect(x+5.3*s,dy+.5*s,1.8*s,1.8*s)}
    const dl=d.label,dlw=dl.length*11+10;
    g.fillStyle='#1A1A0ADD';g.fillRect(x-dlw/2-1,dy+9.5*s-1,dlw+2,18);
    g.fillStyle=ac.p;g.fillRect(x-dlw/2,dy+9.5*s,dlw,16);g.fillStyle=ac.s;g.fillRect(x-dlw/2,dy+9.5*s,dlw,2);
    g.fillStyle='#FFF';g.font='bold 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';g.textAlign='center';g.fillText(dl,x,dy+9.5*s+13);
  });
  S.bg=o;S.bgW=w;S.bgH=h;
}

// ── Desk active screen overlay ──
export function drawActiveScreen(x,fy,agentType){
  const cx=S.cx,fr=S.fr,s=S.P,dy=fy+2;
  const sx=x-3.2*s,sy=dy-7.5*s,sw=6.4*s,sh=5.8*s,scroll=fr*.8;
  switch(agentType){
    case 'bash':cx.fillStyle='#0A1A0A';cx.fillRect(sx,sy,sw,sh);cx.fillStyle='#44DD66';['$ git status','M  src/app.ts','$ npm run build','\u2713 compiled OK','$ node server'].forEach((l,i)=>{const ly=((i*s*1.2+scroll)%(sh+s*1.2))-s*1.2;if(ly>0&&ly<sh){cx.font='6px monospace';cx.textAlign='left';cx.fillText(l,sx+2,sy+ly+6)}});if(fr%40<25)cx.fillRect(sx+sw-s*1.5,sy+sh-s*1.2,s*.6,s*.8);break;
    case 'reader':cx.fillStyle='#0A0A2A';cx.fillRect(sx,sy,sw,sh);cx.fillStyle='#6688CC';for(let i=0;i<6;i++){const lw=[4,5.5,3,5,4.5,2.5][i]*s;cx.fillRect(sx+s*.3,sy+s*.4+i*s*.9,Math.min(lw,sw-s),s*.4)}cx.fillStyle='#FFDD4430';cx.fillRect(sx,sy+s*.3+((fr>>4)%5)*s*.9,sw,s*.6);break;
    case 'writer':cx.fillStyle='#1E1E2E';cx.fillRect(sx,sy,sw,sh);const cLines=[[{c:'#C678DD',t:'const'},{c:'#ABB2BF',t:' x ='}],[{c:'#C678DD',t:'func'},{c:'#61AFEF',t:' run'}],[{c:'#98C379',t:'  "ok"'}],[{c:'#E06C75',t:'  if'},{c:'#ABB2BF',t:' err'}],[{c:'#56B6C2',t:'  ret'},{c:'#D19A66',t:' 42'}],[{c:'#C678DD',t:'}'}]];cx.font='6px monospace';cx.textAlign='left';cLines.forEach((parts,i)=>{let lx=sx+2;parts.forEach(p=>{cx.fillStyle=p.c;cx.fillText(p.t,lx,sy+7+i*s*1.1);lx+=p.t.length*3.5})});cx.fillStyle='#5C6370';for(let i=0;i<5;i++)cx.fillText(''+(i+1),sx-1,sy+7+i*s*1.1);break;
    case 'finder':cx.fillStyle='#1A1A2A';cx.fillRect(sx,sy,sw,sh);cx.fillStyle='#44AA88';cx.font='6px monospace';cx.textAlign='left';cx.fillText('? grep',sx+2,sy+7);cx.fillStyle='#888';['src/a.ts:12','lib/b.js:45','pkg/c.rs:89'].forEach((l,i)=>cx.fillText(l,sx+2,sy+7+(i+1)*s*1.2));cx.fillStyle='#FFDD4440';cx.fillRect(sx+s*2,sy+s*1.3+((fr>>4)%3)*s*1.2,s*2,s*.8);break;
    case 'mcp':cx.fillStyle='#0A1A1A';cx.fillRect(sx,sy,sw,sh);const nodes=[[.3,.3],[.7,.25],[.5,.6],[.2,.7],[.8,.7]];cx.fillStyle='#44DDAA';nodes.forEach(([nx,ny])=>cx.fillRect(sx+sw*nx-2,sy+sh*ny-2,4,4));cx.fillStyle='#44DDAA40';[[0,1],[0,2],[1,2],[2,3],[2,4]].forEach(([a,b])=>{const[ax,ay]=nodes[a],[bx,by]=nodes[b];const prog=((fr*.02+a*.3)%1);cx.fillRect(sx+sw*(ax+(bx-ax)*prog)-1,sy+sh*(ay+(by-ay)*prog)-1,3,3)});break;
    case 'agent':cx.fillStyle='#1A1020';cx.fillRect(sx,sy,sw,sh);cx.fillStyle='#AA88FF';cx.font='6px monospace';cx.textAlign='left';cx.fillText('TASKS',sx+2,sy+7);['#1 run','#2 build','#3 test'].forEach((l,i)=>{cx.fillStyle=i===((fr>>5)%3)?'#FFDD44':'#8866CC';cx.fillText(' '+l,sx+2,sy+14+i*s*1.1)});break;
    case 'web':cx.fillStyle='#FFF';cx.fillRect(sx,sy,sw,sh);cx.fillStyle='#E8E8E8';cx.fillRect(sx,sy,sw,s*1.2);cx.fillStyle='#888';cx.font='5px monospace';cx.textAlign='left';cx.fillText('https://',sx+2,sy+s*.9);cx.fillStyle='#EEEEFF';cx.fillRect(sx+s*.3,sy+s*1.8,sw-s*.6,s*1.5);cx.fillStyle='#DDDDEE';cx.fillRect(sx+s*.3,sy+s*3.6,sw*.5,s*1);cx.fillStyle='#CCDDFF';cx.fillRect(sx+s*.3+sw*.55,sy+s*3.6,sw*.35,s*1);break;
    case 'serena':cx.fillStyle='#1A1510';cx.fillRect(sx,sy,sw,sh);cx.fillStyle='#B8860B';cx.font='6px monospace';cx.textAlign='left';['class Foo','  fn bar','  fn baz','  val x','impl Tr'].forEach((l,i)=>{cx.fillStyle=i===((fr>>4)%5)?'#FFD080':'#8B6914';cx.fillText(l,sx+2,sy+7+i*s*1)});break;
    default:cx.fillStyle='#114422';cx.fillRect(sx,sy,sw,sh);cx.fillStyle='#44DD66';cx.fillRect(sx+s*.4,sy+s*.5,3.5*s,s*.6);cx.fillRect(sx+s*.4,sy+s*1.8,5*s,s*.6);if(fr%60<35)cx.fillRect(sx+s*3,sy+sh-s*1.5,s*.7,s*.7);
  }
  cx.fillStyle='#00000012';for(let i=0;i<sh;i+=2)cx.fillRect(sx,sy+i,sw,1);
  cx.fillStyle=agentType==='web'?'#FFFFFF08':'#44FF6608';cx.fillRect(sx-1,sy-1,sw+2,sh+2);
}

// ── Particle texture cache (PixiJS) ──
export function getParticleTexture(color,shape,size){
  const key=color+shape+size;
  if(S.pixiPtexCache.has(key))return S.pixiPtexCache.get(key);
  const g=new PIXI.Graphics();
  const c=PIXI.Color?new PIXI.Color(color).toNumber():parseInt(color.replace('#',''),16);
  if(shape==='circle'){g.circle(0,0,size/2).fill(c)}
  else if(shape==='star'){g.rect(-size/2,-size*.15,size,size*.3).fill(c);g.rect(-size*.15,-size/2,size*.3,size).fill(c)}
  else{g.rect(0,0,size,size).fill(c)}
  const tex=S.pixiApp.renderer.generateTexture(g);g.destroy();
  if(S.pixiPtexCache.size>200){const first=S.pixiPtexCache.keys().next().value;S.pixiPtexCache.get(first).destroy();S.pixiPtexCache.delete(first)}
  S.pixiPtexCache.set(key,tex);return tex;
}

// ── Particles ──
export function spawnP(x,y,n,type,tool){
  if(S.pts.length>120)return;
  const colors=type==='error'?['#FF3300','#FF6644','#CC0000']:type==='success'?(TOOL_COLORS[tool]||['#44DD66','#88FF88','#22AA44']):['#FFD080','#FFAA22','#FF6644','#FFDD44','#88BBFF'];
  for(let i=0;i<Math.min(n,12);i++){
    const shape=type==='error'?'rect':Math.random()>.6?'star':Math.random()>.3?'circle':'rect';
    const sz=2+Math.random()*3.5,color=colors[i%colors.length];
    const p={x:x+(Math.random()-.5)*14,y:y+(Math.random()-.5)*6,vx:(Math.random()-.5)*4.5,vy:-Math.random()*4.5-1,l:35+Math.random()*25,c:color,z:sz,shape,rot:Math.random()*6.28,rv:(Math.random()-.5)*.25,sprite:null};
    if(S.pixiReady&&S.L.particles){try{const tex=getParticleTexture(color,shape,Math.ceil(sz));const sp=new PIXI.Sprite(tex);sp.anchor.set(0.5);sp.x=p.x;sp.y=p.y;sp.rotation=p.rot;S.L.particles.addChild(sp);p.sprite=sp}catch(e){}}
    S.pts.push(p);
  }
}

export function drawPts(){
  const cx=S.cx;
  S.pts=S.pts.filter(p=>{
    p.x+=p.vx;p.y+=p.vy;p.vy+=.06;p.vx*=.985;p.l--;p.rot+=p.rv;
    if(p.l<=0){if(p.sprite){p.sprite.destroy();p.sprite=null}return false}
    const alpha=Math.min(p.l/25,1);
    if(p.sprite){p.sprite.x=p.x;p.sprite.y=p.y;p.sprite.rotation=p.rot;p.sprite.alpha=alpha}
    else{cx.globalAlpha=alpha;cx.fillStyle=p.c;
      if(p.shape==='star'){cx.save();cx.translate(p.x,p.y);cx.rotate(p.rot);cx.fillRect(-p.z/2,-p.z*.15,p.z,p.z*.3);cx.fillRect(-p.z*.15,-p.z/2,p.z*.3,p.z);cx.restore()}
      else if(p.shape==='circle'){cx.beginPath();cx.arc(p.x,p.y,p.z/2,0,6.28);cx.fill()}
      else{cx.fillRect(p.x,p.y,p.z,p.z)}cx.globalAlpha=1}
    return true;
  });
}

// ── Floating text ──
export function spawnFloatingText(x,y,text,color,size){
  const ft={x,y,text,color:color||'#FFD080',size:size||12,life:60,vy:-1.2,alpha:1,sprite:null};
  if(S.pixiReady&&S.L.effects){try{const t=new PIXI.Text({text,style:{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',fontWeight:'bold',fontSize:ft.size,fill:ft.color,dropShadow:true,dropShadowColor:'#000000',dropShadowDistance:1,dropShadowAlpha:0.6}});t.anchor.set(0.5);t.x=x;t.y=y;S.L.effects.addChild(t);ft.sprite=t}catch(e){}}
  S.floatingTexts.push(ft);
}

export function updateFloatingTexts(){
  const cx=S.cx;
  S.floatingTexts=S.floatingTexts.filter(ft=>{
    ft.y+=ft.vy;ft.life--;ft.alpha=Math.min(ft.life/20,1);
    if(ft.life<=0){if(ft.sprite){ft.sprite.destroy();ft.sprite=null}return false}
    if(ft.sprite){ft.sprite.x=ft.x;ft.sprite.y=ft.y;ft.sprite.alpha=ft.alpha}
    else if(!S.pixiReady){cx.globalAlpha=ft.alpha;cx.font=`bold ${ft.size}px -apple-system,sans-serif`;cx.textAlign='center';cx.fillStyle='#00000080';cx.fillText(ft.text,ft.x+1,ft.y+1);cx.fillStyle=ft.color;cx.fillText(ft.text,ft.x,ft.y);cx.globalAlpha=1}
    return true;
  });
}

// ── Shake ──
export function triggerShake(intensity){S.shakeFrames=12;S.shakeIntensity=intensity||3}
