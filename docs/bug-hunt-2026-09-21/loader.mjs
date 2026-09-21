// Rimappa il pacchetto di workspace '@youty/shared' sullo shim: così i probe
// caricano il codice vero della sezione agenda senza installare node_modules.
export async function resolve(specifier, context, next) {
  if (specifier === '@youty/shared') {
    return { url: new URL('./shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
