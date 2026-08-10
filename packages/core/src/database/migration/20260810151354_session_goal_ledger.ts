import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810151354_session_goal_ledger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`session_id\` text PRIMARY KEY,
          \`objective\` text NOT NULL,
          \`acceptance_criteria\` text NOT NULL,
          \`constraints\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`source_message_ids\` text NOT NULL,
          \`version\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_ledger\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`text\` text NOT NULL,
          \`source_message_ids\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`superseded_by\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_ledger_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_ledger_session_status_updated_idx\` ON \`session_ledger\` (\`session_id\`,\`status\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
