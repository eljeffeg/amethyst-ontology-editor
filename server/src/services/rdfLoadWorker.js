import { workerData, parentPort } from "node:worker_threads";
import oxigraph from "oxigraph";

const { text, format, graphIri } = workerData;
try {
  const store = new oxigraph.Store();
  store.load(text, { format, to_graph_name: oxigraph.namedNode(graphIri) });
  const nquads = store.dump({
    format: "application/n-quads",
    from_graph_name: oxigraph.namedNode(graphIri),
  });
  parentPort.postMessage({ ok: true, nquads });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
