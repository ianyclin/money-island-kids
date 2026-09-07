CREATE TABLE `family_mutation_locks` (
	`family_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `activities` ADD `operation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_activities_family_operation` ON `activities` (`family_id`,`operation_id`);--> statement-breakpoint
ALTER TABLE `savings_transfers` ADD `operation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_savings_transfers_family_operation` ON `savings_transfers` (`family_id`,`operation_id`);