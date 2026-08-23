import "dotenv/config";
import { createApp } from "./app";
import { logger } from "./util/logger";

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
});

const port = Number(process.env.PORT) || 3000;

const app = createApp();

app.listen(port, () => {
  logger.info(`fader-be listening on http://localhost:${port}`);
  logger.info(`Swagger UI: http://localhost:${port}/docs`);
});
