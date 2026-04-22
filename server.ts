/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // In-memory store for the latest extraction result
  let lastResult = {
    message: "No data captured yet. Execute an extraction in the monitoring dashboard.",
    timestamp: null
  };

  app.use(express.json());

  // API Route to get the latest JSON
  app.get("/json", (req, res) => {
    res.json(lastResult);
  });

  // Internal API to update the latest result from the frontend
  app.post("/api/results", (req, res) => {
    lastResult = {
      ...req.body,
      server_timestamp: Date.now()
    };
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`JSON Endpoint available at http://localhost:${PORT}/json`);
  });
}

startServer();
