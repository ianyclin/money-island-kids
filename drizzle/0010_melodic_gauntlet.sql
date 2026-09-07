ALTER TABLE `annual_harvests` ADD `market_value_reduction` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `annual_harvests` ADD `cost_basis_reduction` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `investment_holdings` ADD `quote_price` real;--> statement-breakpoint
ALTER TABLE `investment_holdings` ADD `quote_as_of` text;--> statement-breakpoint
ALTER TABLE `investment_holdings` ADD `quote_source` text;--> statement-breakpoint
ALTER TABLE `investment_purchases` ADD `operation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_investment_purchases_family_operation` ON `investment_purchases` (`family_id`,`operation_id`);--> statement-breakpoint
ALTER TABLE `savings_transfers` ADD `activity_id` text;