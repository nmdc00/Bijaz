#!/usr/bin/env bash
set -euo pipefail

QMD_BIN="${1:-$(command -v qmd || true)}"
if [[ -z "${QMD_BIN}" ]]; then
  echo "qmd not found on PATH; skipping patch"
  exit 0
fi

QMD_BIN_REAL="$(readlink -f "$QMD_BIN")"
QMD_DIR="$(cd "$(dirname "$QMD_BIN_REAL")" && pwd)"
QMD_TS="${QMD_DIR}/src/qmd.ts"
QMD_LAUNCHER="${QMD_DIR}/../qmd"

if [[ ! -f "${QMD_TS}" ]]; then
  echo "QMD source not found at ${QMD_TS}; skipping patch"
  exit 0
fi

python3 - <<'PY' "${QMD_TS}"
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

old = """async function querySearch(query: string, opts: OutputOptions, _embedModel: string = DEFAULT_EMBED_MODEL, _rerankModel: string = DEFAULT_RERANK_MODEL): Promise<void> {\n  const store = getStore();\n\n  if (opts.collection) {\n    const coll = getCollectionFromYaml(opts.collection);\n    if (!coll) {\n      console.error(`Collection not found: ${opts.collection}`);\n      closeDb();\n      process.exit(1);\n    }\n  }\n\n  checkIndexHealth(store.db);\n\n  await withLLMSession(async () => {\n    const results = await hybridQuery(store, query, {\n      collection: opts.collection,\n      limit: opts.all ? 500 : (opts.limit || 10),\n      minScore: opts.minScore || 0,\n      hooks: {\n        onStrongSignal: (score) => {\n          process.stderr.write(`${c.dim}Strong BM25 signal (${score.toFixed(2)}) — skipping expansion${c.reset}\\n`);\n        },\n        onExpand: (original, expanded) => {\n          logExpansionTree(original, expanded);\n          process.stderr.write(`${c.dim}Searching ${expanded.length + 1} queries...${c.reset}\\n`);\n        },\n        onRerankStart: (chunkCount) => {\n          process.stderr.write(`${c.dim}Reranking ${chunkCount} chunks...${c.reset}\\n`);\n          progress.indeterminate();\n        },\n        onRerankDone: () => {\n          progress.clear();\n        },\n      },\n    });\n\n    closeDb();\n\n    if (results.length === 0) {\n      console.log(\"No results found.\");\n      return;\n    }\n\n    // Map to CLI output format — use bestChunk for snippet display\n    outputResults(results.map(r => ({\n      file: r.file,\n      displayPath: r.displayPath,\n      title: r.title,\n      body: r.bestChunk,\n      chunkPos: r.bestChunkPos,\n      score: r.score,\n      context: r.context,\n      docid: r.docid,\n    })), query, { ...opts, limit: results.length });\n  }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });\n}\n"""

new = """async function querySearch(query: string, opts: OutputOptions, _embedModel: string = DEFAULT_EMBED_MODEL, _rerankModel: string = DEFAULT_RERANK_MODEL): Promise<void> {\n  const store = getStore();\n\n  if (opts.collection) {\n    const coll = getCollectionFromYaml(opts.collection);\n    if (!coll) {\n      console.error(`Collection not found: ${opts.collection}`);\n      closeDb();\n      process.exit(1);\n    }\n  }\n\n  checkIndexHealth(store.db);\n\n  process.stderr.write(`${c.dim}Safe query mode: using BM25 retrieval only (vector/LLM query path disabled on this host).${c.reset}\\n`);\n\n  const results = store.searchFTS(query, opts.all ? 500 : (opts.limit || 10))\n    .filter(r => !opts.collection || r.collectionName === opts.collection);\n\n  closeDb();\n\n  if (results.length === 0) {\n    console.log(\"No results found.\");\n    return;\n  }\n\n  outputResults(results.map(r => ({\n    file: r.filepath,\n    displayPath: r.displayPath,\n    title: r.title,\n    body: r.body,\n    score: r.score,\n    context: r.context,\n    docid: r.docid,\n  })), query, { ...opts, limit: results.length });\n}\n"""

if old in text:
    path.write_text(text.replace(old, new))
elif "Safe query mode: using BM25 retrieval only" not in text:
    raise SystemExit(f"Expected querySearch block not found in {path}")
PY

if [[ -f "${QMD_LAUNCHER}" ]]; then
  python3 - <<'PY' "${QMD_LAUNCHER}"
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = 'exec "$BUN" "$SCRIPT_DIR/src/qmd.ts" "$@"'
new = 'exec env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$BUN" "$SCRIPT_DIR/src/qmd.ts" "$@"'
if new in text:
    raise SystemExit(0)
if old not in text:
    raise SystemExit(f"Expected launcher exec not found in {path}")
path.write_text(text.replace(old, new))
PY
fi

echo "Patched QMD safe query mode at ${QMD_TS}"
