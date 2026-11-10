/** Purpose and review records contain no duplicated private prompt or generated text. */
export const CINEMA_HOST_ASSISTANCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cinema_host_assistance (
    request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,review_status TEXT NOT NULL DEFAULT 'REVIEW',
    result_id TEXT NOT NULL DEFAULT '',reviewed_by TEXT NOT NULL DEFAULT '',reviewed_at TEXT NOT NULL DEFAULT '')`,
];
