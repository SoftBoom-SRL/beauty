// Hook di risoluzione: '@youty/shared' → test/shared-shim.mjs.
export async function resolve(specifier, context, next) {
  if (specifier === '@youty/shared') {
    return { url: new URL('./shared-shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
