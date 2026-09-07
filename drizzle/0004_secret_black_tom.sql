CREATE TABLE `annual_harvests` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`holding_id` text NOT NULL,
	`year` integer NOT NULL,
	`percentage` real NOT NULL,
	`sold_units` real NOT NULL,
	`reference_market_value` integer NOT NULL,
	`net_proceeds` integer NOT NULL,
	`destination_dream_id` text,
	`sale_date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_annual_harvests_profile_year` ON `annual_harvests` (`profile_id`,`year`);--> statement-breakpoint
CREATE TABLE `dream_jars` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`target_amount` integer NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dream_jars_profile_status` ON `dream_jars` (`profile_id`,`status`);--> statement-breakpoint
CREATE TABLE `family_security` (
	`id` text PRIMARY KEY NOT NULL,
	`pin_salt` text NOT NULL,
	`pin_hash` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monthly_reflections` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`month` text NOT NULL,
	`proud_text` text DEFAULT '' NOT NULL,
	`change_text` text DEFAULT '' NOT NULL,
	`plan_text` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_monthly_reflections_profile_month` ON `monthly_reflections` (`profile_id`,`month`);
--> statement-breakpoint
PRAGMA optimize;
