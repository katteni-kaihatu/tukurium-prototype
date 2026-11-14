import type { Json } from "@tukurium/eks";

export interface DebugVariable {
  name: string;
  value: Json;
  writable: boolean;
  unavailable?: boolean;
}
export interface DebugFrame {
  id: number;
  name: string;
  line: number;
  variables: DebugVariable[];
}
export interface DebugPoint {
  systemId: string;
  entity: string | null;
  line: number;
  frames: DebugFrame[];
  entities: Json;
  error?: string;
}
export interface DebugEdit {
  frameId: number;
  name: string;
  value: Json;
}

/** VM 内でのみ値を読む。待機中に VM を呼び直さず、再開の返り値で変更する。 */
export const DEBUG_PRELUDE = `
let __debugActive = false;
let __debugEntities = [];
globalThis.__debugBridge = (() => {
  const stack = [];
  let nextId = 0;
  let reported = new WeakSet();
  const snapshot = (frame, error) => ({
    systemId: __current, entity: __entity, line: frame.line,
    frames: stack.map(f => ({id:f.id,name:f.name,line:f.line,variables:(f.read ? f.read() : []).map(v => {
      try { return {name:v[0],value:__codec.encode(v[1].value),writable:v[2] && v[1].ok,unavailable:!v[1].ok}; }
      catch { return {name:v[0],value:null,writable:false,unavailable:true}; }
    })})),
    entities: __codec.encode(__debugEntities), ...(error ? {error} : {})
  });
  const stop = (frame, error) => {
    const edits = JSON.parse(__debugPause(JSON.stringify(snapshot(frame, error))));
    if(edits.abort) { __debugActive=false; throw new Error("デバッグ実行を終了しました"); }
    for (const edit of edits) {
      const target = stack.find(f => f.id === edit.frameId);
      if (target && target.write) target.write(edit.name, __codec.decode(edit.value));
    }
  };
  return {
    reset() { stack.length=0; reported=new WeakSet(); },
    enter(name,line) { const f={id:++nextId,name,line,read:null,write:null}; if(__debugActive) stack.push(f); return f; },
    leave(f) { if(stack[stack.length-1]===f) stack.pop(); },
    read(fn) { try { return {ok:true,value:fn()}; } catch { return {ok:false}; } },
    point(f,line,read,write) { if(!__debugActive)return; f.line=line; f.read=read; f.write=write; stop(f); },
    error(f,error) { if(!__debugActive)return; if(error && typeof error==='object') { if(reported.has(error))return; reported.add(error); } stop(f,String(error)); }
  };
})();
`;
