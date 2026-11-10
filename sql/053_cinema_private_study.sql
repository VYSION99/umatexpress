-- Private AI explanations: owner-only endpoints; never room chat or socket payloads.
CREATE TABLE IF NOT EXISTS cinema_private_study_requests (
    id TEXT PRIMARY KEY,session_id TEXT NOT NULL,owner_id TEXT NOT NULL,question TEXT NOT NULL,
    anchor_id TEXT NOT NULL DEFAULT '',video_context TEXT NOT NULL DEFAULT '',through_sequence INTEGER NOT NULL,
    status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,claim_token TEXT NOT NULL DEFAULT '',lease_until TEXT NOT NULL DEFAULT '',
    answer TEXT NOT NULL DEFAULT '',citations TEXT NOT NULL DEFAULT '[]',dependencies TEXT NOT NULL DEFAULT '[]',error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cinema_private_owner ON cinema_private_study_requests(owner_id,created_at);
CREATE INDEX IF NOT EXISTS idx_cinema_private_room ON cinema_private_study_requests(session_id,created_at);
CREATE INDEX IF NOT EXISTS idx_cinema_private_queue ON cinema_private_study_requests(status,lease_until,created_at);
CREATE INDEX IF NOT EXISTS idx_cinema_private_expiry ON cinema_private_study_requests(expires_at);
CREATE TABLE IF NOT EXISTS cinema_private_study_evidence (
    request_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,digest TEXT NOT NULL,
    PRIMARY KEY(request_id,kind,source_id));
CREATE INDEX IF NOT EXISTS idx_cinema_private_source ON cinema_private_study_evidence(kind,source_id);
