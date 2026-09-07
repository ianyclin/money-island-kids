ALTER TABLE `backups` ADD `r2_key` text;--> statement-breakpoint
ALTER TABLE `backups` ADD `r2_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `backups` ADD `r2_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backups` ADD `r2_error` text;--> statement-breakpoint
ALTER TABLE `family_security` ADD `pin_failed_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `family_security` ADD `pin_locked_until` text;--> statement-breakpoint
ALTER TABLE `family_security` ADD `recovery_lookup_hash` text;--> statement-breakpoint
CREATE INDEX `idx_family_security_recovery_lookup` ON `family_security` (`recovery_lookup_hash`);