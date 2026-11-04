// TEST_ONLY: three fixed service substitutions, scoped to the actual entry module.
import { registerHooks } from 'node:module';

const entry = new URL('../../../src/finite-policy-ci.ts', import.meta.url).href;
const services = new URL('./services.mjs', import.meta.url).href;
const replaced = new Set(['./authority.ts', './production.ts', './runner.ts']);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (replaced.has(specifier) && context.parentURL?.endsWith('/finite-policy-ci.ts') && context.parentURL !== entry) {
      throw new Error('TEST_ONLY_ENTRY_PARENT_REFUSED');
    }
    if (context.parentURL === entry && replaced.has(specifier)) {
      return { url: services, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
