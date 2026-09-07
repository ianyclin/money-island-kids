CREATE TABLE `activity_changes` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`edited_label` text,
	`edited_note` text,
	`edited_entry_date` text,
	`deleted_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `investment_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'ETF' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_investment_presets_symbol` ON `investment_presets` (`symbol`);
--> statement-breakpoint
PRAGMA optimize;
