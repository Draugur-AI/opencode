import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812095536_monitor_check",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`monitor_check\` (
          \`id\` text PRIMARY KEY,
          \`monitor_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`check_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`exit_code\` integer,
          \`triggered\` integer,
          \`detail\` text,
          \`tail_preview\` text,
          \`checksum\` text,
          \`bytes\` integer,
          \`object_ref\` text,
          CONSTRAINT \`fk_monitor_check_monitor_id_monitor_id_fk\` FOREIGN KEY (\`monitor_id\`) REFERENCES \`monitor\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_monitor_check_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`monitor_check_session_time_idx\` ON \`monitor_check\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`monitor_check_monitor_seq_idx\` ON \`monitor_check\` (\`monitor_id\`,\`check_seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
