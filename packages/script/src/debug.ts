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

/** VM 内でのみ値を読む。待機中に VM を呼び直さず、再開の返り値で変更する。 */
export const DEBUG_PRELUDE = `
let __debugActive = false;
let __debugEntities = [];
globalThis.__debugBridge = (() => {
  const stack = [];
  let nextId = 0;
  let nextScope = 0;
  const scopes = new WeakMap();
  let reported = new WeakSet();
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
  const snapshot = (frame, error) => ({
    systemId: frame.systemId || __current, entity: __entity, line: frame.line,
    frames: stack.map(f => ({id:f.id,name:f.name,line:f.line,systemId:f.systemId,variables:(f.read ? f.read() : []).map(v => {
      try { return {name:v[0],value:__codec.encode(copy(v[1].value)),writable:v[2] && v[1].ok,unavailable:!v[1].ok,state:stateRef(v[1].value),binding:v[3]}; }
      catch { return {name:v[0],value:null,writable:false,unavailable:true}; }
    })})),
    entities: __codec.encode(__debugEntities), ...(error ? {error} : {})
  });
  const stop = (frame, error) => {
    const edits = JSON.parse(__debugPause(JSON.stringify(snapshot(frame, error))));
    if(edits.abort) { __debugActive=false; throw new Error("デバッグ実行を終了しました"); }
    for (const edit of edits) {
      if(edit.kind==='state') {
        const e=__debugEntities.find(e=>e.id===edit.entity);
        if(e && e.states[edit.koko]) e.states[edit.koko][edit.fieldName || edit.field]=__codec.decode(edit.value);
        continue;
      }
      const target = stack.find(f => f.id === edit.frameId);
      if (target && target.write) target.write(edit.name, __codec.decode(edit.value));
    }
  };
  return {
    scope() { return ++nextScope; },
    scopeFor(value) { let id=scopes.get(value); if(id===undefined){id=++nextScope;scopes.set(value,id);} return id; },
    binding(key,owner) { try { return key+':'+owner(); } catch { return undefined; } },
    reset() { stack.length=0; reported=new WeakSet(); },
    enter(name,line,systemId) { const f={id:++nextId,name,line,systemId,read:null,write:null}; if(__debugActive) stack.push(f); return f; },
    leave(f) { if(stack[stack.length-1]===f) stack.pop(); },
    read(fn) { try { return {ok:true,value:fn()}; } catch { return {ok:false}; } },
    point(f,line,read,write) { if(!__debugActive)return; f.line=line; f.read=read; f.write=write; stop(f); },
    error(f,error) { if(!__debugActive)return; if(error && typeof error==='object') { if(reported.has(error))return; reported.add(error); } stop(f,String(error)); }
  };
})();
`;
