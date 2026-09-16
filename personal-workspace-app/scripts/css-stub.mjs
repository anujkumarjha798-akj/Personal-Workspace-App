// Test-only loader: lets `tsx` import editor modules that pull in .css files.
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
  return next(url, context);
}
