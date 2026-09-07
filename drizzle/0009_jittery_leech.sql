CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `families_code_unique` ON `families` (`code`);--> statement-breakpoint
CREATE TABLE `family_credentials` (
	`family_id` text PRIMARY KEY NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`recovery_salt` text NOT NULL,
	`recovery_hash` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP INDEX `idx_investment_presets_symbol`;--> statement-breakpoint
ALTER TABLE `investment_presets` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_investment_presets_family_symbol` ON `investment_presets` (`family_id`,`symbol`);--> statement-breakpoint
ALTER TABLE `activities` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `activity_changes` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `annual_harvests` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `backups` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `data_imports` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `dream_jars` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `family_projects` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `family_security` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `investment_holdings` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `investment_purchases` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_reflections` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_preferences` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `savings_transfers` ADD `family_id` text DEFAULT 'family-default' NOT NULL;--> statement-breakpoint
ALTER TABLE `trusted_devices` ADD `family_id` text DEFAULT 'family-default' NOT NULL;
