import { migrate } from "./index.js";

// Run migrations on startup
migrate();

export { db } from "./index.js";
