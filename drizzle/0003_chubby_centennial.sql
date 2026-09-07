CREATE TABLE `investment_holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'ETF' NOT NULL,
	`units` real DEFAULT 0 NOT NULL,
	`cost_basis` integer DEFAULT 0 NOT NULL,
	`market_value` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'TWD' NOT NULL,
	`price_updated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_investment_holdings_profile_symbol` ON `investment_holdings` (`profile_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `investment_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`holding_id` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`units` real NOT NULL,
	`total_cost` integer NOT NULL,
	`purchase_date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_investment_purchases_profile_date` ON `investment_purchases` (`profile_id`,`purchase_date`);