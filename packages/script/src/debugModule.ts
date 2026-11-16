import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";

/** 非同期版はデバッグ実行を始めたときだけ読み込む。 */
export async function createDebugModule() {
  const { default: variant } = await import("@jitl/quickjs-wasmfile-release-asyncify");
  return newQuickJSAsyncWASMModuleFromVariant(variant);
}
