ALTER TABLE `account_tokens` ADD `health_check_enabled` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `health_check_interval_minutes` integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `health_check_model` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `health_check_last_run_at` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `health_check_next_run_at` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `health_check_last_available` integer;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `health_check_last_message` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `health_check_last_latency_ms` integer;
