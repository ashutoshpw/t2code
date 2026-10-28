import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_assets ADD COLUMN blob_generation INTEGER CHECK(blob_generation >= 0)`;
  yield* sql`CREATE INDEX spaces_assets_generation_pending ON spaces_assets(asset_id) WHERE blob_generation IS NULL`;
  yield* sql`ALTER TABLE spaces_asset_blobs ADD COLUMN unreferenced_at_ms INTEGER`;
  yield* sql`ALTER TABLE spaces_asset_blobs ADD COLUMN grace_epoch INTEGER NOT NULL DEFAULT -1`;
  yield* sql`ALTER TABLE spaces_asset_blobs ADD COLUMN deletion_attempt TEXT`;
  yield* sql`ALTER TABLE spaces_asset_blobs ADD COLUMN deletion_owner TEXT`;
  yield* sql`ALTER TABLE spaces_asset_blobs ADD COLUMN deletion_error TEXT`;
  yield* sql`ALTER TABLE spaces_asset_blobs ADD COLUMN collected_generation INTEGER`;
  yield* sql`CREATE INDEX spaces_asset_collection_due ON spaces_asset_blobs(state,grace_epoch,unreferenced_at_ms,digest)`;
  yield* sql`ALTER TABLE spaces_asset_uploads ADD COLUMN attempt_owner TEXT`;
  yield* sql`ALTER TABLE spaces_asset_uploads ADD COLUMN staging_identity TEXT`;
  yield* sql`ALTER TABLE spaces_asset_uploads ADD COLUMN attempt_quiescent_at_ms INTEGER`;
  yield* sql`ALTER TABLE spaces_asset_uploads ADD COLUMN staging_reserved INTEGER NOT NULL DEFAULT 1 CHECK(staging_reserved IN (0,1))`;
  yield* sql`CREATE INDEX spaces_asset_pending_digest ON spaces_asset_uploads(digest,upload_id)
    WHERE state IN ('receiving','verified') OR cleanup_pending=1`;
  yield* sql`CREATE TABLE spaces_asset_collection (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_token TEXT, owner_pid INTEGER CHECK(owner_pid>0),
    owner_retired INTEGER NOT NULL DEFAULT 1 CHECK(owner_retired IN (0,1)), epoch INTEGER NOT NULL DEFAULT 0,
    projection_phase TEXT NOT NULL CHECK(projection_phase IN ('handles','current','history','done')), projection_cursor TEXT NOT NULL DEFAULT '', projection_page TEXT NOT NULL DEFAULT '',
    projection_revision INTEGER NOT NULL DEFAULT -1, projection_asset TEXT NOT NULL DEFAULT '',
    scan_cursor TEXT NOT NULL DEFAULT '',scan_done INTEGER NOT NULL DEFAULT 0,
    last_work_rows INTEGER NOT NULL DEFAULT 0,last_planned_bytes INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO spaces_asset_collection(singleton,projection_phase)
    SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM spaces_assets LIMIT 1)
      OR EXISTS(SELECT 1 FROM spaces_block_asset_refs LIMIT 1)
      OR EXISTS(SELECT 1 FROM spaces_revision_asset_refs LIMIT 1) THEN 'handles' ELSE 'done' END`;
  for (const [table, key] of [
    ["spaces_block_asset_refs", "block_id"],
    ["spaces_revision_asset_refs", "page_id,to_revision,asset_id"],
  ] as const) {
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN blob_digest TEXT`);
    yield* sql.unsafe(`CREATE INDEX ${table}_digest ON ${table}(blob_digest)`);
    yield* sql.unsafe(
      `CREATE INDEX ${table}_unresolved ON ${table}(${key}) WHERE blob_digest IS NULL`,
    );
    const where = key
      .split(",")
      .map((column) => `${column}=NEW.${column}`)
      .join(" AND ");
    for (const event of ["INSERT", "UPDATE OF asset_id"] as const) {
      const suffix = event === "INSERT" ? "insert" : "update";
      yield* sql.unsafe(`CREATE TRIGGER ${table}_${suffix}_collection_guard BEFORE ${event} ON ${table}
        WHEN EXISTS(SELECT 1 FROM spaces_assets a JOIN spaces_asset_blobs b ON b.digest=a.digest
          WHERE a.asset_id=NEW.asset_id AND b.state IN ('deleting','deleted'))
        BEGIN SELECT RAISE(ABORT,'asset generation unavailable'); END`);
      yield* sql.unsafe(`CREATE TRIGGER ${table}_${suffix}_digest AFTER ${event} ON ${table} BEGIN
        UPDATE ${table} SET blob_digest=(SELECT digest FROM spaces_assets WHERE asset_id=NEW.asset_id AND blob_generation IS NOT NULL) WHERE ${where};
        UPDATE spaces_asset_blobs SET unreferenced_at_ms=NULL WHERE unreferenced_at_ms IS NOT NULL AND digest IN (SELECT digest FROM spaces_assets WHERE asset_id=NEW.asset_id OR asset_id=${event === "INSERT" ? "NEW" : "OLD"}.asset_id);
        UPDATE spaces_asset_collection SET scan_done=0,scan_cursor='' WHERE singleton=1 AND (scan_done<>0 OR scan_cursor<>'');
      END`);
    }
    yield* sql.unsafe(`CREATE TRIGGER ${table}_delete_digest AFTER DELETE ON ${table} BEGIN
      UPDATE spaces_asset_blobs SET unreferenced_at_ms=NULL WHERE unreferenced_at_ms IS NOT NULL AND digest IN (SELECT digest FROM spaces_assets WHERE asset_id=OLD.asset_id);
      UPDATE spaces_asset_collection SET scan_done=0,scan_cursor='' WHERE singleton=1 AND (scan_done<>0 OR scan_cursor<>'');
    END`);
  }
  yield* sql`CREATE TRIGGER spaces_asset_upload_reference AFTER UPDATE OF state,digest,cleanup_pending ON spaces_asset_uploads BEGIN
    UPDATE spaces_asset_blobs SET unreferenced_at_ms=NULL WHERE unreferenced_at_ms IS NOT NULL AND (digest=NEW.digest OR digest=OLD.digest);
    UPDATE spaces_asset_collection SET scan_done=0,scan_cursor='' WHERE singleton=1 AND (scan_done<>0 OR scan_cursor<>'');
  END`;
  yield* sql`CREATE TRIGGER spaces_asset_published_collection AFTER UPDATE OF state ON spaces_asset_blobs
    WHEN NEW.state='ready' AND OLD.state<>'ready' BEGIN
      UPDATE spaces_asset_blobs SET unreferenced_at_ms=NULL WHERE digest=NEW.digest;
      UPDATE spaces_asset_collection SET scan_done=0,scan_cursor='' WHERE singleton=1 AND (scan_done<>0 OR scan_cursor<>'');
    END`;
  for (const event of ["INSERT", "UPDATE", "DELETE"] as const)
    yield* sql.unsafe(`CREATE TRIGGER spaces_asset_collection_issue_${event.toLowerCase()} AFTER ${event} ON spaces_asset_reconciliation_issues BEGIN
      UPDATE spaces_asset_collection SET epoch=epoch+1,scan_done=0,scan_cursor='' WHERE singleton=1;
    END`);
  yield* sql`UPDATE spaces_asset_reconciliation SET format_version=0,block_cursor='',blocks_done=0,
    history_page='',history_revision=-1,history_done=0`;
});
