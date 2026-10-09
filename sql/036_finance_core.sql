-- Finance core. Apply after 035_payment_inbox.sql. Safe to rerun.

CREATE TABLE IF NOT EXISTS checkout_requests (
    scope TEXT NOT NULL, actor TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETE','REVIEW')), response TEXT, response_status INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope,actor,request_key));

CREATE TABLE IF NOT EXISTS payment_intents (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, order_reference TEXT NOT NULL, customer TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount>0), currency TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(product,order_reference));

CREATE TABLE IF NOT EXISTS payment_attempts (
    reference TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES payment_intents(id), provider TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('CREATED','PENDING','SUCCESSFUL','FAILED','REVIEW')),
    amount INTEGER NOT NULL, currency TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS provider_operations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, reference TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('STARTED','COMPLETE','REJECTED','UNKNOWN')),
    result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS financial_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT NOT NULL,
    payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING', error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), processed_at TEXT);

CREATE INDEX IF NOT EXISTS idx_financial_outbox_pending ON financial_outbox(state,sequence);

CREATE TABLE IF NOT EXISTS financial_snapshots (
    source TEXT NOT NULL, source_id TEXT NOT NULL, sequence INTEGER NOT NULL, balances TEXT NOT NULL,
    PRIMARY KEY(source,source_id));

CREATE TABLE IF NOT EXISTS ledger_journals (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, currency TEXT NOT NULL,
    posted INTEGER NOT NULL DEFAULT 0, previous_sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS ledger_lines (
    journal_id TEXT NOT NULL REFERENCES ledger_journals(id), account TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount!=0), PRIMARY KEY(journal_id,account));

CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_lines(account,journal_id);

CREATE TRIGGER IF NOT EXISTS ledger_projection_order BEFORE INSERT ON ledger_journals
    WHEN NEW.previous_sequence!=COALESCE((SELECT sequence FROM financial_snapshots WHERE source=NEW.source AND source_id=NEW.source_id),0)
    BEGIN SELECT RAISE(ABORT,'PROJECTION_CONFLICT'); END;

CREATE TRIGGER IF NOT EXISTS ledger_balanced BEFORE UPDATE OF posted ON ledger_journals
    WHEN NEW.posted=1 AND (COALESCE((SELECT SUM(amount) FROM ledger_lines WHERE journal_id=NEW.id),0)!=0)
    BEGIN SELECT RAISE(ABORT,'UNBALANCED_JOURNAL'); END;

CREATE TRIGGER IF NOT EXISTS ledger_no_edit BEFORE UPDATE ON ledger_journals WHEN OLD.posted=1
    BEGIN SELECT RAISE(ABORT,'IMMUTABLE_JOURNAL'); END;

CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_journals
    BEGIN SELECT RAISE(ABORT,'IMMUTABLE_JOURNAL'); END;

CREATE TRIGGER IF NOT EXISTS ledger_line_no_update BEFORE UPDATE ON ledger_lines
    BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POSTING'); END;

CREATE TRIGGER IF NOT EXISTS ledger_line_no_delete BEFORE DELETE ON ledger_lines
    BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POSTING'); END;

CREATE TRIGGER IF NOT EXISTS ledger_line_no_append BEFORE INSERT ON ledger_lines
    WHEN COALESCE((SELECT posted FROM ledger_journals WHERE id=NEW.journal_id),1)!=0
    BEGIN SELECT RAISE(ABORT,'JOURNAL_CLOSED'); END;

CREATE TABLE IF NOT EXISTS finance_audit (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
    reason TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS finance_reconciliation (
    id TEXT PRIMARY KEY, reference TEXT NOT NULL, kind TEXT NOT NULL, expected INTEGER,
    observed INTEGER, currency TEXT NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS finance_capture_sources (source TEXT PRIMARY KEY, installed_at TEXT NOT NULL);
