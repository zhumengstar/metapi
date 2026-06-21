CREATE TABLE `account_token_group_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`token_group` text NOT NULL,
	`group_ratio` real,
	`group_ratio_key` text DEFAULT '' NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_token_group_preferences_account_group_ratio_unique` ON `account_token_group_preferences` (`account_id`,`token_group`,`group_ratio_key`);--> statement-breakpoint
CREATE INDEX `account_token_group_preferences_account_idx` ON `account_token_group_preferences` (`account_id`);--> statement-breakpoint
CREATE INDEX `account_token_group_preferences_group_idx` ON `account_token_group_preferences` (`token_group`);
