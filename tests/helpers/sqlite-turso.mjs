import { DatabaseSync } from 'node:sqlite';

/** Run the actual application SQL, including Hrana conditional transactions. */
export function sqliteTurso() {
  const db = new DatabaseSync(':memory:');
  function execute(stmt) {
    const args = (stmt.args || []).map(a => a.type === 'null' ? null : a.type === 'integer' || a.type === 'float' ? Number(a.value) : a.value);
    const query = db.prepare(stmt.sql);
    const cols = query.columns().map(c => ({ name: c.name }));
    if (cols.length) {
      const rows = query.all(...args).map(row => cols.map(c => ({ value: row[c.name] })));
      return { cols, rows, affected_row_count: Number(db.prepare('SELECT changes() AS n').get().n) };
    }
    const result = query.run(...args);
    return { rows: [], cols: [], affected_row_count: Number(result.changes) };
  }
  function request(req) {
    if (req.type === 'close') return { response: { result: {} } };
    if (req.type === 'execute') {
      try { return { response: { result: execute(req.stmt) } }; }
      catch (error) { return { error: { message: error.message } }; }
    }
    const step_results = [], step_errors = [];
    const condition = c => !c || (c.type === 'ok' ? step_results[c.step] != null : c.type === 'not' ? !condition(c.cond) : c.conds.every(condition));
    for (const step of req.batch.steps) {
      if (!condition(step.condition)) { step_results.push(null); step_errors.push(null); continue; }
      try { step_results.push(execute(step.stmt)); step_errors.push(null); }
      catch (error) { step_results.push(null); step_errors.push({ message: error.message }); }
    }
    return { response: { result: { step_results, step_errors } } };
  }
  return { db, fetch: async (_url, options) => Response.json({ results: JSON.parse(options.body).requests.map(request) }) };
}
