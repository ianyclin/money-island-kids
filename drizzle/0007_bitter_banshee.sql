CREATE TABLE `profile_preferences` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`garden_species` text DEFAULT 'tree' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
SELECT 1;
--> statement-breakpoint
SELECT 1;
--> statement-breakpoint
PRAGMA optimize;
