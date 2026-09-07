CREATE TABLE `family_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`reward` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_profile_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_family_projects_status_updated` ON `family_projects` (`status`,`updated_at`);