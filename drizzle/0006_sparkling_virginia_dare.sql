CREATE TABLE `data_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`imported_at` text NOT NULL,
	`record_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `family_access` (
	`id` text PRIMARY KEY NOT NULL,
	`code_salt` text NOT NULL,
	`code_hash` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trusted_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_trusted_devices_token_hash` ON `trusted_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_trusted_devices_active` ON `trusted_devices` (`revoked_at`,`last_used_at`);--> statement-breakpoint
PRAGMA optimize;
