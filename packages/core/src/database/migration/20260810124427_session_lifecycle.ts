import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810124427_session_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_lifecycle_request\` (
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`lifecycle_revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_lifecycle_request_pk\` PRIMARY KEY(\`session_id\`, \`request_id\`),
          CONSTRAINT \`fk_session_lifecycle_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_tombstone\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`time_purged\` integer NOT NULL,
          \`last_lifecycle_revision\` integer NOT NULL,
          CONSTRAINT \`fk_session_tombstone_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`lifecycle\` text DEFAULT 'active' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`lifecycle_revision\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`time_trashed\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`purge_after\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`trash_restore_to\` text;`)
      // Backfill: a pre-migration install expressed "archived" only as a timestamp. Without this
      // every archived session would reappear in the default active view after upgrading.
      // Hand-added — the schema generator emits DDL only, never data movement.
      yield* tx.run(`UPDATE \`session\` SET \`lifecycle\` = 'archived' WHERE \`time_archived\` IS NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_lifecycle_request_session_time_idx\` ON \`session_lifecycle_request\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_project_lifecycle_updated_id_idx\` ON \`session\` (\`project_id\`,\`lifecycle\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_tombstone_time_purged_idx\` ON \`session_tombstone\` (\`time_purged\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
