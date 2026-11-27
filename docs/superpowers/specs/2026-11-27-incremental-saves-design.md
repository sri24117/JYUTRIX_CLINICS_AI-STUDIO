# Incremental database saves

## Why
Every save truncated every table and re-inserted every row one at a time. Measured on a laptop with PostgreSQL: one save took about 5 s with 5,000 stored messages, 17 s with 20,000 and 42 s with 50,000. Each incoming WhatsApp webhook waits for a save, and Kapso gives up after 10 s, so a busy clinic would eventually make webhooks time out. Nothing deletes old messages, so history only grows.

## Goals
- A save costs what changed, not what exists.
- Same data, same tables, same behaviour for the rest of the app. Upgrading needs no migration.

## Non-goals
- No change to the in-memory model, the schema, or the code that mutates data.
- No data retention or deletion policy (tracked separately in the launch checklist).

## Approaches considered
1. **Compare each row with its last saved JSON (chosen).** Works with the existing mutation style (`msg.status = ...`, `array.filter`, `splice`) without touching ~50 call sites. Costs CPU proportional to row count (about 1.2 ms per 1,000 rows), measured at 0.3 s with 200,000 messages.
2. Mark rows dirty at every change. Faster at huge sizes but requires changing every place that mutates data and is easy to get wrong.
3. Delay saves and write in batches. Reduces writes but risks losing data on a crash and does not make a single save cheaper.

## Design
- `SPECS` describes each table: key, columns and which rows are live. A snapshot map of row JSON per table is built after load and updated after each successful save.
- A save diffs memory against the snapshots, then in one transaction: deletes removed rows, updates changed rows, inserts new rows (batched, 500 per statement), prunes expired sessions and holds, and writes the sequence counters.
- Concurrent callers share one follow-up save. If the row-by-row save fails, the transaction is rolled back and the original full rewrite runs instead.
- Snapshots are replaced only after a successful commit, so a failed save is retried in full next time.

## Verified
Database tests (`tests/persistence.test.ts`): unchanged save writes zero rows, one change writes one row, large history stays fast, add/change/remove mirrors exactly, slot freed and retaken in one save, slot swap falls back to a full rewrite, expired rows pruned, bursts coalesced, restart then save rewrites nothing. A database written by the previous release loads and saves with every existing row byte-identical. The full clinic workflow (63 checks) and a restart (8 checks) pass.
