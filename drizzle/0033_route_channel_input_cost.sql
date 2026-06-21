ALTER TABLE `route_channels` ADD `total_input_tokens` integer DEFAULT 0;--> statement-breakpoint
UPDATE `route_channels`
SET `total_input_tokens` = coalesce((
  SELECT sum(coalesce(`proxy_logs`.`prompt_tokens`, 0))
  FROM `proxy_logs`
  WHERE `proxy_logs`.`channel_id` = `route_channels`.`id`
    AND `proxy_logs`.`status` = 'success'
), 0);
