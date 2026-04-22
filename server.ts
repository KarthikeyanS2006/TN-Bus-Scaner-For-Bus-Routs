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

import { Octokit } from "octokit";

const GITHUB_OWNER = "KarthikeyanS2006";
const GITHUB_REPO = "TN-Bus-Scaner-For-Bus-Routs";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // In-memory store for monitoring history (short-term cache)
  let lastResult: any = {
    message: "No data captured yet. Execute an extraction in the monitoring dashboard.",
    timestamp: null
  };
  const history: any[] = [];

  const octokit = new Octokit({ 
    auth: process.env.GITHUB_TOKEN 
  });

  async function pushToGithub(data: any) {
    if (!process.env.GITHUB_TOKEN) {
      console.warn("[GITHUB]: Token missing. Skipping remote persistence.");
      return;
    }

    try {
      const path = "datasets/detections.json";
      let currentContent = "[]";
      let sha = undefined;

      try {
        const { data: fileData }: any = await octokit.rest.repos.getContent({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          path,
        });
        sha = fileData.sha;
        currentContent = Buffer.from(fileData.content, 'base64').toString();
      } catch (e) {
        console.log("[GITHUB]: Creating new dataset file.");
      }

      const historyData = JSON.parse(currentContent);
      historyData.push(data);
      
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path,
        message: `🤖 Auto-Log: ${data.plate} detected`,
        content: Buffer.from(JSON.stringify(historyData, null, 2)).toString('base64'),
        sha,
      });
      console.log("[GITHUB]: Successfully synced detection.");
    } catch (err) {
      console.error("[GITHUB]: Sync failed", err);
    }
  }

  app.use(express.json());

  // API Route to get the latest JSON
  app.get("/json", (req, res) => {
    res.json(lastResult);
  });

  // Export Dataset (CSV)
  app.get("/csv", (req, res) => {
    if (history.length === 0) {
      return res.send("No data captured yet to generate dataset.");
    }

    // Standardized headers for the dataset
    const headers = [
      "ISO_Timestamp", 
      "Day_of_Week", 
      "Calendar_Date", 
      "Local_Time_24h", 
      "License_Plate", 
      "Operator_Type", 
      "Bus_Service_Name", 
      "Route_ID", 
      "Destination_Target", 
      "AI_Confidence"
    ];

    const rows = history.map(item => {
      const dt = new Date(item.server_timestamp);
      return [
        dt.toISOString(),
        dt.toLocaleDateString('en-US', { weekday: 'long' }),
        dt.toISOString().split('T')[0], // YYYY-MM-DD
        dt.toLocaleTimeString('en-GB', { hour12: false }), // 24h format
        `"${item.plate}"`,
        `"${item.operator}"`,
        `"${item.bus_name || 'N/A'}"`,
        `"${item.route || 'N/A'}"`,
        `"${item.destination}"`,
        item.confidence.toFixed(4)
      ];
    });

    const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=tn_transit_dataset.csv');
    res.status(200).send(csvContent);
  });

  // Internal API to update the latest result from the frontend
  app.post("/api/results", async (req, res) => {
    const data = {
      ...req.body,
      server_timestamp: Date.now()
    };
    lastResult = data;
    history.push(data);
    
    // Automatic Background Sync to GitHub Repository
    pushToGithub(data);
    
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

  return app;
}

const appPromise = startServer();
export default appPromise;
