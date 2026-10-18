import './wasm_exec.js';
import { Physics, type GoPhysics } from './bridge';

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

const runtime = globalThis as typeof globalThis & {
  Go: new () => GoRuntime;
  sailPhysics?: GoPhysics;
};

export async function loadPhysics(wasm: BufferSource | Response): Promise<Physics> {
  const go = new runtime.Go();
  const { instance } = wasm instanceof Response
    ? await WebAssembly.instantiateStreaming(wasm, go.importObject)
    : await WebAssembly.instantiate(wasm, go.importObject);
  // Go registers its synchronous exports before blocking in main's select {}.
  void go.run(instance);
  const api = runtime.sailPhysics;
  if (!api) {
    throw new Error('physics wasm did not register sailPhysics');
  }
  return new Physics(api);
}
