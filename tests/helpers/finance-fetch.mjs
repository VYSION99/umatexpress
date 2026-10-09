import { sqliteTurso } from './sqlite-turso.mjs';

/** The legacy product fixtures keep their tables; new finance SQL runs in SQLite. */
export function withFinanceFetch(productFetch) {
  const finance=sqliteTurso();
  const financeSql=/\b(checkout_requests|payment_intents|payment_attempts|provider_operations|financial_outbox|financial_snapshots|ledger_journals|ledger_lines|finance_audit|finance_reconciliation|finance_capture_sources)\b/i;
  return {db:finance.db,fetch:(url,options)=>{
    if(!String(url).includes('/v2/pipeline')) return productFetch(url,options);
    const body=JSON.parse(options.body);
    const statements=body.requests.flatMap(request=>request.stmt?[request.stmt.sql]:request.batch?.steps.map(step=>step.stmt.sql)||[]);
    if(statements.some(sql=>financeSql.test(sql)||/sqlite_master|PRAGMA table_info/i.test(sql))) return finance.fetch(url,options);
    return productFetch(url,options);
  }};
}
