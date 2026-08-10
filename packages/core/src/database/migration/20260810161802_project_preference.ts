import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810161802_project_preference",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`project_preference\` (
          \`project_id\` text PRIMARY KEY,
          \`favorite\` integer DEFAULT false NOT NULL,
          \`rank\` text,
          \`hidden\` integer DEFAULT false NOT NULL,
          \`time_last_opened\` integer,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_project_preference_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
