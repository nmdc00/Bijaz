import { setLearningRuntimeContext } from '../src/memory/learning_observability.js';

const runId = String(process.argv[2] ?? '').trim();
const policyVersion = String(process.argv[3] ?? '').trim();

if (!runId) {
  console.error('Usage: pnpm exec tsx scripts/set_learning_runtime.ts <run-id> [policy-version]');
  process.exit(1);
}

const updated = setLearningRuntimeContext({
  runId,
  policyVersion: policyVersion || runId,
});

console.log(JSON.stringify(updated, null, 2));
