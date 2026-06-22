ALTER TABLE `token_model_availability` ADD COLUMN `route_enabled_source` VARCHAR(191) DEFAULT 'manual';
ALTER TABLE `token_model_availability` ADD COLUMN `health_check_success_streak` INT DEFAULT 0;
ALTER TABLE `token_model_availability` ADD COLUMN `route_manual_disabled_at` VARCHAR(191);
