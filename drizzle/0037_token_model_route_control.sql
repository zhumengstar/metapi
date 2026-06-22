ALTER TABLE `token_model_availability` ADD `route_enabled_source` text DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE `token_model_availability` ADD `health_check_success_streak` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `token_model_availability` ADD `route_manual_disabled_at` text;
