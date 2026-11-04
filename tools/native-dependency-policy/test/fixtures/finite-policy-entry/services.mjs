// TEST_ONLY invented service results. Nothing here supplies actual policy or native authority.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.TEST_ONLY_POLICY_ENTRY_ROOT;
const tracePath = process.env.TEST_ONLY_POLICY_ENTRY_TRACE;
const mode = process.env.TEST_ONLY_POLICY_ENTRY_CASE;
if (!root || !tracePath || path.dirname(tracePath) !== root) throw new Error('TEST_ONLY_TRACE_REFUSED');
const entry = fileURLToPath(new URL('../../../src/finite-policy-ci.ts', import.meta.url));
const expectedKeys = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'CARGO', 'CARGO_HOME',
  'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'CARGO_NET_OFFLINE', 'CARGO_TERM_COLOR', 'NO_COLOR', 'PATH', 'SYSTEMROOT'].toSorted();
const trace = { authority: 0, producer: 0, runner: 0, constructorArgsEmpty: false,
  physicalBindings: false, optionKeysExact: false, environmentKeysExact: false,
  environmentFrozenNullPrototype: false, selectorLeak: true, itemPhase: false, sameServices: false };
let authority, producer;
const save = () => fs.writeFileSync(tracePath, JSON.stringify(trace));

export class RepositoryAuthority {
  constructor(...args) {
    trace.authority++;
    trace.constructorArgsEmpty = args.length === 0;
    authority = this;
    save();
  }
}
export function createProductionProducer(options) {
  trace.producer++;
  trace.optionKeysExact = JSON.stringify(Object.keys(options).toSorted()) === JSON.stringify(
    ['repositoryRoot', 'databaseRoot', 'cargoHome', 'expectedCargo', 'expectedDeny', 'environment'].toSorted(),
  );
  trace.physicalBindings = options.repositoryRoot === path.resolve(path.dirname(entry), '../../..') &&
    options.databaseRoot === path.join(root, 'database') && options.cargoHome === path.join(root, 'cargo-home') &&
    options.expectedCargo === path.join(root, 'cargo') && options.expectedDeny === path.join(root, 'deny');
  const environment = options.environment;
  trace.environmentKeysExact = JSON.stringify(Object.keys(environment).toSorted()) === JSON.stringify(expectedKeys);
  trace.environmentFrozenNullPrototype = Object.isFrozen(environment) && Object.getPrototypeOf(environment) === null;
  trace.selectorLeak = Object.keys(environment).some(key => key.startsWith('DRAFTYAK_') || key.startsWith('TEST_ONLY_'));
  trace.physicalBindings &&= environment.CARGO === options.expectedCargo && environment.CARGO_HOME === options.cargoHome &&
    environment.PATH === path.join(root, 'search') && environment.SYSTEMROOT === path.join(root, 'system');
  producer = Object.freeze({ testOnlyProducer: true });
  save();
  return producer;
}
export async function runNativePolicy(input) {
  trace.runner++;
  trace.itemPhase = input.phase === 'item';
  trace.sameServices = input.authority === authority && input.producer === producer &&
    JSON.stringify(Object.keys(input).toSorted()) === JSON.stringify(['phase', 'authority', 'producer'].toSorted());
  save();
  if (mode === 'throw') throw new Error('TEST_ONLY_PRIVATE_ERROR_MUST_NOT_ESCAPE');
  const exitCode = mode === 'ordinary-failure' ? 1 : ['stale', 'finalizer-failure'].includes(mode) ? 2 : 0;
  const output = {
    version: 1, phase: 'item', verdict: exitCode === 0 ? 'strict-pass' : 'refuse',
    reason: mode === 'stale' ? 'AUTHORITY_CHANGED' : mode === 'finalizer-failure' ? 'PRODUCER_UNAVAILABLE' :
      mode === 'ordinary-failure' ? 'AUDIT_INVALID' : null,
    authorityRevision: null, authorityRecordDigest: null, runId: null, reportDigest: null,
    binding: null, audit: null, rawExits: null, accepted: [],
  };
  if (mode === 'finalizer-failure') {
    output.rawExits = { full: { exitCode: 0, signal: null }, advisory: { exitCode: 0, signal: null } };
    output.finalizerFailure = 'PRODUCER_UNAVAILABLE';
  }
  if (mode === 'large-output') output.authorityRevision = 'x'.repeat(65537);
  return { exitCode, output };
}
