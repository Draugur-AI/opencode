import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812055027_monitor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`monitor\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`source\` text NOT NULL,
          \`interval_ms\` integer NOT NULL,
          \`timeout_ms\` integer NOT NULL,
          \`condition\` text NOT NULL,
          \`status\` text DEFAULT 'starting' NOT NULL,
          \`attempt\` integer DEFAULT 0 NOT NULL,
          \`max_attempts\` integer,
          \`output_policy\` text NOT NULL,
          \`profile_snapshot_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_started\` integer,
          \`time_checked\` integer,
          \`time_finished\` integer,
          \`revision\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_monitor_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`monitor_session_idx\` ON \`monitor\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`monitor_status_idx\` ON \`monitor\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
