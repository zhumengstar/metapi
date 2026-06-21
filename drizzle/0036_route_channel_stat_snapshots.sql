CREATE TABLE `route_channel_stat_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity_key` text NOT NULL,
	`model_pattern` text NOT NULL,
	`account_id` integer NOT NULL,
	`token_id` integer,
	`oauth_route_unit_id` integer,
	`source_model` text,
	`success_count` integer DEFAULT 0,
	`fail_count` integer DEFAULT 0,
	`total_latency_ms` integer DEFAULT 0,
	`total_cost` real DEFAULT 0,
	`total_input_tokens` integer DEFAULT 0,
	`last_used_at` text,
	`last_selected_at` text,
	`last_fail_at` text,
	`consecutive_fail_count` integer DEFAULT 0 NOT NULL,
	`cooldown_level` integer DEFAULT 0 NOT NULL,
	`cooldown_until` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `route_channel_stat_snapshots_identity_unique` ON `route_channel_stat_snapshots` (`identity_key`);--> statement-breakpoint
CREATE INDEX `route_channel_stat_snapshots_model_pattern_idx` ON `route_channel_stat_snapshots` (`model_pattern`);--> statement-breakpoint
CREATE INDEX `route_channel_stat_snapshots_account_id_idx` ON `route_channel_stat_snapshots` (`account_id`);--> statement-breakpoint
CREATE INDEX `route_channel_stat_snapshots_token_id_idx` ON `route_channel_stat_snapshots` (`token_id`);--> statement-breakpoint
CREATE INDEX `route_channel_stat_snapshots_oauth_route_unit_id_idx` ON `route_channel_stat_snapshots` (`oauth_route_unit_id`);
