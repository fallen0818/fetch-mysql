CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `email` varchar(150) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `users` (`id`, `name`, `email`, `created_at`) VALUES (1, 'Alice', 'alice@example.com', 'Tue Aug 04 2026 08:12:33 GMT+0800 (Philippine Standard Time)');
INSERT INTO `users` (`id`, `name`, `email`, `created_at`) VALUES (2, 'Bob', 'bob@example.com', 'Tue Aug 04 2026 08:12:33 GMT+0800 (Philippine Standard Time)');
INSERT INTO `users` (`id`, `name`, `email`, `created_at`) VALUES (3, 'Charlie', 'charlie@example.com', 'Tue Aug 04 2026 08:12:33 GMT+0800 (Philippine Standard Time)');
