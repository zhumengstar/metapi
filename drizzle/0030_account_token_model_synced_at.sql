ALTER TABLE `account_tokens` ADD `model_synced_at` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `auto_disabled_at` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `auto_disabled_reason` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `auto_disabled_previous_enabled` integer;
