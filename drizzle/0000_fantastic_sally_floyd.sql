CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`amount` integer NOT NULL,
	`spend_delta` integer DEFAULT 0 NOT NULL,
	`bank_delta` integer DEFAULT 0 NOT NULL,
	`market_delta` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`entry_date` text NOT NULL,
	`source` text DEFAULT 'app' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text NOT NULL,
	`accent` text NOT NULL,
	`spending_balance` integer DEFAULT 0 NOT NULL,
	`bank_balance` integer DEFAULT 0 NOT NULL,
	`market_value` integer DEFAULT 0 NOT NULL,
	`stock_code` text,
	`stock_units` real DEFAULT 0 NOT NULL,
	`stock_cost` integer DEFAULT 0 NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
