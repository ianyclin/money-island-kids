CREATE TABLE `savings_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_savings_transfers_profile_status` ON `savings_transfers` (`profile_id`,`status`);--> statement-breakpoint
PRAGMA optimize;
