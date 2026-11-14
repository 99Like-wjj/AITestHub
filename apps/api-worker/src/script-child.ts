import { getQuickJS } from 'quickjs-emscripten';
import { z } from 'zod';

// This is a trusted kernel. User JavaScript is evaluated only inside QuickJS WASM.
const requestSchema = z.strictObject({
  script: z.string().max(64_000),
  input: z.json(),
  timeoutMs: z.number().int().min(10).max(5000),
  memoryLimitBytes: z
    .number()
    .int()
    .min(4 * 1024 * 1024)
    .max(64 * 1024 * 1024),
  protectedPaths: z
    .array(
      z
        .string()
        .max(2000)
        .regex(/^(?:\/(?:[^~]|~[01])*)*$/),
    )
    .max(2000),
});
const chunks: Buffer[] = [];
let bytes = 0;
try {
  for await (const raw of process.stdin) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    bytes += chunk.length;
    if (bytes > 1_048_576) throw new Error('Input limit');
    chunks.push(chunk);
  }
  const request = requestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
  );
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(request.memoryLimitBytes);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + request.timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted = Date.now() >= deadline;
    return interrupted;
  });
  const context = runtime.newContext();
  let response: { ok: boolean; output?: unknown; code?: string };
  try {
    const code = `(() => { const input = (()=>{
      const raw=${JSON.stringify(request.input)}, blocked=new Set(${JSON.stringify(request.protectedPaths)}), cache=new WeakMap();
      const get=Reflect.get.bind(Reflect), descriptor=Object.getOwnPropertyDescriptor.bind(Object), keys=Reflect.ownKeys.bind(Reflect);
      const cacheGet=cache.get.bind(cache), cacheSet=cache.set.bind(cache), has=blocked.has.bind(blocked), SafeError=Error, SafeProxy=Proxy;
      const replace=Function.prototype.call.bind(String.prototype.replace), stringify=String;
      const encode=key=>replace(replace(stringify(key),/~/g,'~0'),/\\//g,'~1');
      const deny=()=>{const error=new SafeError('Protected input');error.name='AthProtectedInputError';throw error;};
      const readonly=()=>{throw new SafeError('Input is read-only');};
      const wrap=(value,path)=>{
        if(has(path))deny(); if(value===null||typeof value!=='object')return value;
        const prior=cacheGet(value);if(prior)return prior;
        const proxy=new SafeProxy(value,{
          get(target,key,receiver){const next=path+'/'+encode(key);if(has(next))deny();return wrap(get(target,key,receiver),next);},
          getOwnPropertyDescriptor(target,key){const next=path+'/'+encode(key);if(has(next))deny();const d=descriptor(target,key);return d&&'value'in d?{...d,value:wrap(d.value,next)}:d;},
          ownKeys:keys,set:readonly,deleteProperty:readonly,defineProperty:readonly,setPrototypeOf:readonly
        });cacheSet(value,proxy);return proxy;
      }; return wrap(raw,'');
    })();
      const validName = name => typeof name==='string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && !['__proto__','constructor','prototype'].includes(name);
      const variables = new Proxy(Object.create(null), {
        set(target,key,value){ if(!validName(key))throw new Error('Variable key rejected'); target[key]=value; return true; },
        defineProperty(target,key,descriptor){ if(!validName(key))throw new Error('Variable key rejected'); Object.defineProperty(target,key,descriptor); return true; },
        setPrototypeOf(){throw new Error('Prototype change rejected');}
      }); const assertions = [];
      const setVariable = (name,value) => { variables[name] = value; };
      const assert = (passed,message='脚本断言') => assertions.push({passed:Boolean(passed),message:String(message)});
      const stringify = JSON.stringify.bind(JSON);
      const returned = (function(){ 'use strict';\n${request.script}\n})();
      return stringify(returned === undefined ? {variables,assertions} : returned);
    })()`;
    const result = context.evalCode(code, 'case-extension.js');
    if (result.error) {
      const nameHandle = context.getProp(result.error, 'name');
      const name =
        context.typeof(nameHandle) === 'string'
          ? context.getString(nameHandle)
          : '';
      nameHandle.dispose();
      result.error.dispose();
      response = {
        ok: false,
        code: interrupted
          ? 'SCRIPT_TIMEOUT'
          : name === 'AthProtectedInputError'
            ? 'SCRIPT_INPUT_PROTECTED'
            : 'SCRIPT_ERROR',
      };
    } else {
      try {
        if (runtime.hasPendingJob())
          response = { ok: false, code: 'SCRIPT_ASYNC_UNSUPPORTED' };
        else {
          const serialized = context.getString(result.value);
          response =
            Buffer.byteLength(serialized) <= 1_048_576
              ? { ok: true, output: JSON.parse(serialized) as unknown }
              : { ok: false, code: 'SCRIPT_RESULT_INVALID' };
        }
      } catch {
        response = { ok: false, code: 'SCRIPT_RESULT_INVALID' };
      } finally {
        result.value.dispose();
      }
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
  process.stdout.write(JSON.stringify(response));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, code: 'SCRIPT_ERROR' }));
}
