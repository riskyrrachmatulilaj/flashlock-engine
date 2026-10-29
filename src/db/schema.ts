import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const sales = pgTable("sales", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  totalStock: integer("total_stock").notNull(),
  availableStock: integer("available_stock").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }),
  status: varchar("status", { length: 32 }).notNull().default("SCHEDULED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 128 }).notNull(),
    quantity: integer("quantity").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("HELD"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("reservations_idempotency_key_idx").on(table.idempotencyKey),
    index("reservations_sale_user_idx").on(table.saleId, table.userId),
    index("reservations_status_idx").on(table.status),
    index("reservations_expires_at_idx").on(table.expiresAt),
  ]
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id),
    userId: varchar("user_id", { length: 128 }).notNull(),
    quantity: integer("quantity").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("CONFIRMED"),
    paymentReference: varchar("payment_reference", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("orders_sale_user_idx").on(table.saleId, table.userId),
    index("orders_reservation_idx").on(table.reservationId),
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id").references(() => sales.id),
    reservationId: uuid("reservation_id"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_event_type_idx").on(table.eventType),
    index("audit_logs_sale_idx").on(table.saleId),
  ]
);

export type Sale = typeof sales.$inferSelect;
export type NewSale = typeof sales.$inferInsert;

export type Reservation = typeof reservations.$inferSelect;
export type NewReservation = typeof reservations.$inferInsert;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
