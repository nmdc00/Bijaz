import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import fixture from '../fixtures/v1_5_context_pack_effectiveness.fixture.json';

const previousDbPath = process.env.THUFIR_DB_PATH;

function setIsolatedDbPath(name: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v15-context-pack-eval-'));
  process.env.THUFIR_DB_PATH = join(dir, `${name}.sqlite`);
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('v1.5 context-pack effectiveness evaluation integration', () => {
  it('generates report artifact from offline fixture expressions', async () => {
    setIsolatedDbPath('fixture-context-pack-eval');

    const { runContextPackEffectivenessEvaluation } = await import(
      '../../src/discovery/context_pack_effectiveness.js'
    );
    const { findReusableArtifact } = await import('../../src/memory/decision_artifacts.js');

    const report = runContextPackEffectivenessEvaluation(fixture.expressions as any, {
      source: 'integration_fixture_context_pack_eval',
      nonTrivialDeltaThreshold: 0.01,
      persistArtifact: true,
    });

    expect(report.sampleSize).toBeGreaterThan(0);
    expect(report.delta.avgQualityScore).toBeGreaterThan(0);
    expect(report.delta.nonTrivialImprovement).toBe(true);

    const artifact = findReusableArtifact({
      kind: 'context_pack_effectiveness_eval',
      fingerprint: report.fingerprint,
      requireNotExpired: false,
      maxAgeMs: 60_000,
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.source).toBe('integration_fixture_context_pack_eval');
    expect((artifact?.payload as { sampleSize?: number }).sampleSize).toBe(report.sampleSize);

    const fixtureRaw = JSON.parse(
      readFileSync('tests/fixtures/v1_5_context_pack_effectiveness.fixture.json', 'utf8')
    ) as { expressions: unknown[] };
    expect(Array.isArray(fixtureRaw.expressions)).toBe(true);
    expect(fixtureRaw.expressions.length).toBe(report.sampleSize);
  });
});
