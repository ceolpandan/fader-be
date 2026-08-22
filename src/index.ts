import "dotenv/config";
import { createApp } from "./app";

const port = Number(process.env.PORT) || 3000;

const app = createApp();

app.listen(port, () => {
  console.log(`fader-be listening on http://localhost:${port}`);
  console.log(`Swagger UI: http://localhost:${port}/docs`);
});
