CREATE TABLE `saved_circuits` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`document` text NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`is_example` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_circuits_name_idx` ON `saved_circuits` (`name`);--> statement-breakpoint
CREATE INDEX `saved_circuits_updated_at_idx` ON `saved_circuits` (`updated_at`);