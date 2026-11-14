import type { Json } from "@tukurium/eks";

export interface DebugRule {
  id: string;
  systemId: string;
  line: number;
  entity: string;
  condition?: unknown[];
  expression?: unknown[];
}

export interface DebugVariable {
  name: string;
  value: Json;
  writable: boolean;
  unavailable?: boolean;
  state?: { entity: string; koko: string };
  binding?: string;
}
export interface DebugFrame {
  systemId?: string;
  id: number;
  name: string;
  line: number;
  variables: DebugVariable[];
}
export interface DebugKokoState {
  id: string;
  name: string;
  fields: { id: string; name: string; value: Json }[];
}
export interface DebugPoint {
  phase?: "mutation";
  systemId: string;
  entity: string | null;
  line: number;
  frames: DebugFrame[];
  entities: Json;
  error?: string;
}
export interface DebugVariableEdit {
  kind?: "variable";
  frameId: number;
  name: string;
  value: Json;
  binding?: string;
}
export interface DebugStateEdit {
  kind: "state";
  entity: string;
  koko: string;
  field: string;
  fieldName?: string;
  value: Json;
}
export type DebugEdit = DebugVariableEdit | DebugStateEdit;
/** System の呼び出しごとに VM へ渡す。ここに当てはまる文だけが、値を写してホストへ渡る。 */
export interface DebugRunConfig {
  /** System の ID → ブレイクポイントとログポイントのある行と、絞り込む Entity（空ならどれでも）。 */
  lines: Record<string, [number, string][]>;
  stepping: boolean;
  /** 見張るフィールド：Entity の ID、VM の中の KokoState のキー、フィールド名。 */
  watch: [string, string, string][];
}

/** VM 内でのみ値を読む。待機中に VM を呼び直さず、再開の返り値で変更する。 */
export const DEBUG_PRELUDE = `
let __debugActive = false;
let __debugEntities = [];
let __debugWatching = false;
// 止まるかもしれない所だけをホストへ渡す。文ごとに値を写すと、Entity の数の 2 乗で遅くなる。
let __debugLines = Object.create(null);
let __debugStepping = false;
let __debugWatch = [];
let __debugSeenSent = false;
globalThis.__setDebugWatching = value => { __debugWatching=value; };
globalThis.__debugConfigure = json => {
  const config = JSON.parse(json);
  __debugLines = Object.create(null);
  for (const key of Object.keys(config.lines)) {
    // 行 → その行で止まる Entity（null はどの Entity でも）。
    const lines = __debugLines[key] = new Map();
    for (const [line, entity] of config.lines[key]) {
      if (!entity) lines.set(line, null);
      else if (!lines.has(line)) lines.set(line, new Set([entity]));
      else if (lines.get(line)) lines.get(line).add(entity);
    }
  }
  __debugStepping = config.stepping;
  __debugWatch = config.watch;
  __debugSeenSent = false;
};
globalThis.__debugBridge = (() => {
  const stack = [];
  let nextId = 0;
  let nextScope = 0;
  const scopes = new WeakMap();
  let reported = new WeakSet();
  let reportedPrimitives = new Set();
  let watched = '';
  // この呼び出しに渡された Entity のうち、見張っているもの。文ごとに探し直さない。
  let targets = [];
  // 見張るフィールドを VM が持つ値で見比べる。変わったかもしれないときだけ、ホストに確かめてもらう。
  const signature = () => {
    let out = '';
    for (const w of targets) {
      const state = w[0].states[w[1]];
      out += '|';
      if (!state) continue;
      try { out += JSON.stringify(__codec.encode(copy(state[w[2]]))); } catch { out += '?' + (++nextScope); }
    }
    return out;
  };
  const watchHit = () => {
    if (!__debugWatching) return false;
    const now = signature();
    const hit = now !== watched;
    watched = now;
    return __debugPending() || hit;
  };
  // 検査するために利用者の getter や toJSON を呼ばない。
  const copy = (value, seen = new Set(), depth = 0) => {
    if(typeof value === 'function' || typeof value === 'symbol') throw new Error('表示できない値');
    if(value===null || typeof value!=='object') return value;
    if(depth>24 || seen.has(value)) throw new Error('深すぎる値または循環参照');
    seen.add(value);
    try {
      if(value instanceof Date) return new Date(Date.prototype.getTime.call(value));
      if(value instanceof Map) { const out=new Map(); Map.prototype.forEach.call(value,(v,k)=>out.set(copy(k,seen,depth+1),copy(v,seen,depth+1))); return out; }
      if(value instanceof Set) { const out=new Set(); Set.prototype.forEach.call(value,v=>out.add(copy(v,seen,depth+1))); return out; }
      const descriptors=Object.getOwnPropertyDescriptors(value);
      const out=Array.isArray(value)?new Array(descriptors.length.value):Object.create(null);
      for(const key of Object.keys(descriptors)) {
        const field=descriptors[key];
        if(!field.enumerable)continue;
        if(field.get || field.set)throw new Error('getter は呼び出しません');
        if(typeof field.value==='function' || typeof field.value==='symbol')continue;
        Object.defineProperty(out,key,{value:copy(field.value,seen,depth+1),enumerable:true,writable:true,configurable:true});
      }
      return out;
    } finally { seen.delete(value); }
  };
  const stateRef = value => {
    if(!value || typeof value!=='object')return undefined;
    for(const e of __debugEntities) for(const key of Object.keys(e.states))
      if(e.states[key]===value)return {entity:e.id,koko:key};
    return undefined;
  };
  const snapshot = (frame, error, phase) => ({
    phase,
    systemId: frame.systemId || __current, entity: __entity, line: frame.line,
    frames: stack.map(f => ({id:f.id,name:f.name,line:f.line,systemId:f.systemId,variables:(f.read ? f.read() : []).map(v => {
      try { return {name:v[0],value:__codec.encode(copy(v[1].value)),writable:v[2] && v[1].ok,unavailable:!v[1].ok,state:stateRef(v[1].value),binding:v[3]}; }
      catch { return {name:v[0],value:null,writable:false,unavailable:true}; }
    })})),
    entities: __codec.encode(__debugEntities), ...(error !== undefined ? {error} : {})
  });
  const stop = (frame, error, phase) => {
    // 値を写す時間は、スクリプトの実行時間の制限に数えない。
    __debugClock(false);
    try {
      const answer = JSON.parse(__debugPause(JSON.stringify(snapshot(frame, error, phase))));
      if(answer.abort) { __debugActive=false; throw new Error("デバッグ実行を終了しました"); }
      __debugStepping = answer.stepping;
      for (const edit of answer.edits) {
        if(edit.kind==='state') {
          const e=__debugEntities.find(e=>e.id===edit.entity);
          if(e && e.states[edit.koko]) e.states[edit.koko][edit.fieldName || edit.field]=__codec.decode(edit.value);
          continue;
        }
        const target = stack.find(f => f.id === edit.frameId);
        if (target && target.write) target.write(edit.name, __codec.decode(edit.value));
      }
    } finally { __debugClock(true); }
  };
  return {
    scope() { return ++nextScope; },
    scopeFor(value) { let id=scopes.get(value); if(id===undefined){id=++nextScope;scopes.set(value,id);} return id; },
    binding(key,owner) { try { return key+':'+owner(); } catch { return undefined; } },
    reset() { stack.length=0; reported=new WeakSet(); reportedPrimitives=new Set(); },
    begin() {
      targets = [];
      for (const w of __debugWatch) {
        const e = __debugEntities.find(e => e.id === w[0]);
        if (e) targets.push([e, w[1], w[2]]);
      }
      watched = __debugWatching ? signature() : '';
    },
    enter(name,line,systemId) { const f={id:++nextId,name,line,systemId,read:null,write:null}; if(__debugActive) stack.push(f); return f; },
    leave(f) { if(stack[stack.length-1]===f) stack.pop(); },
    read(fn) { try { return {ok:true,value:fn()}; } catch { return {ok:false}; } },
    point(f,line,read,write) {
      if(!__debugActive)return;
      f.line=line; f.read=read; f.write=write;
      if(!__debugSeenSent) { __debugSeenSent=true; __debugSeen(); }
      const lines=__debugLines[f.systemId || __current];
      const only=lines && lines.get(line);
      if(__debugStepping || only===null || (only && only.has(__entity)) || watchHit()) stop(f);
    },
    protect(f,line,fn) { f.line=line; try{return fn();}catch(error){this.error(f,error);throw error;} },
    raise(f,line,error) { f.line=line; if(error && typeof error==='object')reported.delete(error);else reportedPrimitives.delete(error); this.error(f,error); return error; },
    changed(f,line,fn) { const result=this.protect(f,line,fn); if(__debugActive && watchHit())stop(f,undefined,'mutation'); return result; },
    error(f,error) {
      if(!__debugActive)return;
      let message;
      if(error && typeof error==='object') {
        if(reported.has(error))return; reported.add(error);
        message='例外が発生しました（詳細は続けた後のエラー欄に出ます）';
      } else {
        if(reportedPrimitives.has(error))return; reportedPrimitives.add(error); message=String(error);
      }
      stop(f,message);
    }
  };
})();
`;
