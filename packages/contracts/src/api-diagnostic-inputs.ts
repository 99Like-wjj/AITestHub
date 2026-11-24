import { z } from 'zod';
import {
  apiRequestStepSchema,
  variableNameSchema,
  type ApiCaseContent,
} from './domain.js';
import {
  apiPlaceholderPattern,
  apiRequestVariableReferences,
} from './api-variable-refs.js';

const diagnosticReferenceSchema = z.string().max(300).regex(
  /^(?:case|extract|steps)\.[A-Za-z0-9_-]+(?:[.\[\]A-Za-z0-9_-]+)?$/,
);
export const diagnosticInputBindingSchema = z.strictObject({
  reference: diagnosticReferenceSchema,
  source: z.enum(['case', 'row']),
  variable: variableNameSchema,
});
export const diagnosticInputBindingsSchema = z.array(diagnosticInputBindingSchema)
  .min(1).max(32)
  .refine(items => new Set(items.map(item=>item.reference)).size===items.length,
    '同一个诊断变量只能指定一个来源。');
export type DiagnosticInputBinding = z.infer<typeof diagnosticInputBindingSchema>;
type ApiStep = ApiCaseContent['steps'][number];
type ApiDataRow = NonNullable<ApiCaseContent['dataRows']>[number];

export function diagnosticReferences(step: ApiStep) {
  const references = [
    ...apiRequestVariableReferences(step),
    ...step.assertions.flatMap(assertion =>
      assertion.source === 'variable' && assertion.path ? [assertion.path] : []),
  ];
  return [...new Set(references.filter(ref => diagnosticReferenceSchema.safeParse(ref).success))];
}

/** Resolve an explicitly authored source only for the isolated step snapshot. */
export function bindDiagnosticStep(
  step: ApiStep,
  originalVariables: ApiCaseContent['variables'],
  selectedRow: ApiDataRow | undefined,
  bindings: readonly DiagnosticInputBinding[],
): {step:ApiStep;variables:ApiCaseContent['variables']} {
  if(!bindings.length)return {step,variables:originalVariables};
  const eligible = new Set(diagnosticReferences(step));
  const applied: Record<string,string> = Object.create(null);
  const variables = {...originalVariables};
  const allocated = new Set([...Object.keys(variables),...Object.keys(selectedRow?.values ?? {})]);
  let index=0;
  for (const binding of bindings){
    if(!eligible.has(binding.reference) || Object.hasOwn(applied,binding.reference))
      throw Error('参考变量未出现在本次诊断步骤中。');
    const source=binding.source==='case'?originalVariables:selectedRow?.values;
    if(!source||!Object.hasOwn(source,binding.variable))
      throw Error('找不到本次诊断明确选择的变量值。');
    const value=source[binding.variable];
    if(value===undefined)throw Error('本次诊断变量值不可读取。');
    let key='diagnosticInput'+ ++index;
    while(allocated.has(key))key='diagnosticInput'+ ++index;
    allocated.add(key);
    variables[key]=value;
    applied[binding.reference]='case.'+key;
  }
  function substitute(value:unknown):unknown{
    if(typeof value==='string')
      return value.replace(apiPlaceholderPattern(), (literal, key:string)=>{
        const found=applied[key];
        return found===undefined?literal:'{{'+found+'}}';
      });
    if(Array.isArray(value))return value.map(substitute);
    if(value&&typeof value==='object')
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,substitute(item)]));
    return value;
  }
  const transformed=apiRequestStepSchema.parse(substitute(step));
  return {
    step:{
      ...transformed,
      assertions:transformed.assertions.map(assertion=>{
        const path=assertion.path && assertion.source==='variable' ? applied[assertion.path] : undefined;
        return path ? {...assertion,path}:assertion;
      }),
    },
    variables,
  };
}
