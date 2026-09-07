CREATE INDEX `idx_activities_profile_date` ON `activities` (`profile_id`,`entry_date`);--> statement-breakpoint
CREATE INDEX `idx_backups_created_at` ON `backups` (`created_at`);