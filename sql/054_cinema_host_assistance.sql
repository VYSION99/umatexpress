-- Host-only AI draft purpose and explicit review records. Generated content stays in private study storage.
CREATE TABLE IF NOT EXISTS cinema_host_assistance (
    request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,review_status TEXT NOT NULL DEFAULT 'REVIEW',
    result_id TEXT NOT NULL DEFAULT '',reviewed_by TEXT NOT NULL DEFAULT '',reviewed_at TEXT NOT NULL DEFAULT '');
