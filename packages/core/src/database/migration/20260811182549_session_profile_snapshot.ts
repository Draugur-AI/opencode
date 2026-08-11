import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811182549_session_profile_snapshot",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_profile_snapshot\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`definition_id\` text NOT NULL,
          \`definition_hash\` text NOT NULL,
          \`title\` text NOT NULL,
          \`agent\` text,
          \`tool_rules\` text NOT NULL,
          \`skill_rules\` text NOT NULL,
          \`mcp_rules\` text NOT NULL,
          \`plugin_rules\` text NOT NULL,
          \`hook_rules\` text NOT NULL,
          \`monitor_rules\` text NOT NULL,
          \`compaction\` text,
          \`system_append\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_profile_snapshot_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`profile_snapshot_id\` text;`)
      yield* tx.run(
        `CREATE INDEX \`session_profile_snapshot_session_created_idx\` ON \`session_profile_snapshot\` (\`session_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
