CREATE TABLE `token_group_pricing` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`account_id` integer,
	`source_key` text NOT NULL,
	`group` text NOT NULL,
	`group_name` text,
	`description` text,
	`ratio` real DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'upstream' NOT NULL,
	`model_count` integer DEFAULT 0 NOT NULL,
	`pricing_available` integer DEFAULT false NOT NULL,
	`last_error` text,
	`refreshed_at` text DEFAULT (datetime('now')),
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `token_group_pricing_source_group_unique` ON `token_group_pricing` (`site_id`,`source_key`,`group`);--> statement-breakpoint
CREATE INDEX `token_group_pricing_site_id_idx` ON `token_group_pricing` (`site_id`);--> statement-breakpoint
CREATE INDEX `token_group_pricing_account_id_idx` ON `token_group_pricing` (`account_id`);--> statement-breakpoint
CREATE INDEX `token_group_pricing_group_idx` ON `token_group_pricing` (`group`);
