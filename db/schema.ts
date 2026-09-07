import { index, real, sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

const familyId = () => text("family_id").notNull().default("family-default");

export const families = sqliteTable("families", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const familyCredentials = sqliteTable("family_credentials", {
  familyId: text("family_id").primaryKey(),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  recoverySalt: text("recovery_salt").notNull(),
  recoveryHash: text("recovery_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: text("locked_until"),
  updatedAt: text("updated_at").notNull(),
});

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  name: text("name").notNull(),
  avatar: text("avatar").notNull(),
  accent: text("accent").notNull(),
  spendingBalance: integer("spending_balance").notNull().default(0),
  bankBalance: integer("bank_balance").notNull().default(0),
  marketValue: integer("market_value").notNull().default(0),
  stockCode: text("stock_code"),
  stockUnits: real("stock_units").notNull().default(0),
  stockCost: integer("stock_cost").notNull().default(0),
  lastSyncedAt: text("last_synced_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const profilePreferences = sqliteTable("profile_preferences", {
  profileId: text("profile_id").primaryKey(),
  familyId: familyId(),
  gardenSpecies: text("garden_species").notNull().default("tree"),
  updatedAt: text("updated_at").notNull(),
});

export const activities = sqliteTable("activities", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  profileId: text("profile_id").notNull(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  amount: integer("amount").notNull(),
  spendDelta: integer("spend_delta").notNull().default(0),
  bankDelta: integer("bank_delta").notNull().default(0),
  marketDelta: integer("market_delta").notNull().default(0),
  note: text("note").notNull().default(""),
  entryDate: text("entry_date").notNull(),
  source: text("source").notNull().default("app"),
  operationId: text("operation_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_activities_profile_date").on(table.profileId, table.entryDate),
  uniqueIndex("idx_activities_family_operation").on(table.familyId, table.operationId),
]);

export const backups = sqliteTable("backups", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  reason: text("reason").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  r2Key: text("r2_key"),
  r2Status: text("r2_status").notNull().default("pending"),
  r2Attempts: integer("r2_attempts").notNull().default(0),
  r2Error: text("r2_error"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_backups_created_at").on(table.createdAt),
]);

export const familyProjects = sqliteTable("family_projects", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  reward: integer("reward").notNull(),
  status: text("status").notNull().default("open"),
  assignedProfileId: text("assigned_profile_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  index("idx_family_projects_status_updated").on(table.status, table.updatedAt),
]);

export const investmentHoldings = sqliteTable("investment_holdings", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  profileId: text("profile_id").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull().default("ETF"),
  units: real("units").notNull().default(0),
  costBasis: integer("cost_basis").notNull().default(0),
  marketValue: integer("market_value").notNull().default(0),
  currency: text("currency").notNull().default("TWD"),
  quotePrice: real("quote_price"),
  quoteAsOf: text("quote_as_of"),
  quoteSource: text("quote_source"),
  priceUpdatedAt: text("price_updated_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_investment_holdings_profile_symbol").on(table.profileId, table.symbol),
]);

export const investmentPurchases = sqliteTable("investment_purchases", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  profileId: text("profile_id").notNull(),
  holdingId: text("holding_id").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  units: real("units").notNull(),
  totalCost: integer("total_cost").notNull(),
  purchaseDate: text("purchase_date").notNull(),
  note: text("note").notNull().default(""),
  operationId: text("operation_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_investment_purchases_profile_date").on(table.profileId, table.purchaseDate),
  uniqueIndex("idx_investment_purchases_family_operation").on(table.familyId, table.operationId),
]);

export const familySecurity = sqliteTable("family_security", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  pinSalt: text("pin_salt").notNull(),
  pinHash: text("pin_hash").notNull(),
  pinFailedAttempts: integer("pin_failed_attempts").notNull().default(0),
  pinLockedUntil: text("pin_locked_until"),
  recoveryLookupHash: text("recovery_lookup_hash"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_family_security_recovery_lookup").on(table.recoveryLookupHash),
]);

export const dreamJars = sqliteTable("dream_jars", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  profileId: text("profile_id").notNull(),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  targetAmount: integer("target_amount").notNull(),
  balance: integer("balance").notNull().default(0),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
  completedAmount: integer("completed_amount"),
}, (table) => [
  index("idx_dream_jars_profile_status").on(table.profileId, table.status),
]);

export const monthlyReflections = sqliteTable("monthly_reflections", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  profileId: text("profile_id").notNull(),
  month: text("month").notNull(),
  proudText: text("proud_text").notNull().default(""),
  changeText: text("change_text").notNull().default(""),
  planText: text("plan_text").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_monthly_reflections_profile_month").on(table.profileId, table.month),
]);

export const annualHarvests = sqliteTable("annual_harvests", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  profileId: text("profile_id").notNull(),
  holdingId: text("holding_id").notNull(),
  year: integer("year").notNull(),
  percentage: real("percentage").notNull(),
  soldUnits: real("sold_units").notNull(),
  referenceMarketValue: integer("reference_market_value").notNull(),
  netProceeds: integer("net_proceeds").notNull(),
  marketValueReduction: integer("market_value_reduction").notNull().default(0),
  costBasisReduction: integer("cost_basis_reduction").notNull().default(0),
  destinationDreamId: text("destination_dream_id"),
  saleDate: text("sale_date").notNull(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_annual_harvests_profile_year").on(table.profileId, table.year),
]);

export const savingsTransfers = sqliteTable("savings_transfers", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  profileId: text("profile_id").notNull(),
  amount: integer("amount").notNull(),
  note: text("note").notNull().default(""),
  status: text("status").notNull().default("pending"),
  activityId: text("activity_id"),
  operationId: text("operation_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => [
  index("idx_savings_transfers_profile_status").on(table.profileId, table.status),
  uniqueIndex("idx_savings_transfers_family_operation").on(table.familyId, table.operationId),
]);

export const activityChanges = sqliteTable("activity_changes", {
  activityId: text("activity_id").primaryKey(),
  familyId: familyId(),
  editedLabel: text("edited_label"),
  editedNote: text("edited_note"),
  editedEntryDate: text("edited_entry_date"),
  deletedAt: text("deleted_at"),
  updatedAt: text("updated_at").notNull(),
});

export const investmentPresets = sqliteTable("investment_presets", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull().default("ETF"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_investment_presets_family_symbol").on(table.familyId, table.symbol),
]);

export const dataImports = sqliteTable("data_imports", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  importedAt: text("imported_at").notNull(),
  recordCount: integer("record_count").notNull().default(0),
});

export const familyAccess = sqliteTable("family_access", {
  id: text("id").primaryKey(),
  codeSalt: text("code_salt").notNull(),
  codeHash: text("code_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const trustedDevices = sqliteTable("trusted_devices", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  tokenHash: text("token_hash").notNull(),
  label: text("label").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("idx_trusted_devices_token_hash").on(table.tokenHash),
  index("idx_trusted_devices_active").on(table.revokedAt, table.lastUsedAt),
]);

export const familySettings = sqliteTable("family_settings", {
  id: text("id").primaryKey(),
  familyId: familyId(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_settings_family").on(table.familyId, table.id)]);

export const familyMutationLocks = sqliteTable("family_mutation_locks", {
  familyId: text("family_id").primaryKey(),
  token: text("token").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});
