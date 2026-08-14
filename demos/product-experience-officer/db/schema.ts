import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const evaluations = sqliteTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().default(""),
    productName: text("product_name").notNull(),
    productUrl: text("product_url").notNull().default(""),
    packId: text("pack_id").notNull(),
    depth: text("depth").notNull(),
    scopesJson: text("scopes_json").notNull().default("[]"),
    status: text("status").notNull(),
    progress: integer("progress").notNull().default(0),
    sessionId: text("session_id"),
    sessionMode: text("session_mode"),
    report: text("report").notNull().default(""),
    reportSource: text("report_source").notNull().default(""),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    errorMessage: text("error_message").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("evaluations_owner_created_at_idx").on(
      table.ownerId,
      table.createdAt,
    ),
    index("evaluations_owner_status_idx").on(table.ownerId, table.status),
  ],
);
