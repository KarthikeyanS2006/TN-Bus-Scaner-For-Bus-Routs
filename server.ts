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

      let historyData = [];
      try {
        historyData = JSON.parse(currentContent);
        if (!Array.isArray(historyData)) historyData = [];
      } catch (e) {
        historyData = [];
      }
      
      historyData.push(data);
      
      // Perform Update
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path,
        message: `🤖 Auto-Log: ${data.plate} detected`,
        content: Buffer.from(JSON.stringify(historyData, null, 2)).toString('base64'),
        sha,
      });

      // Weekly Snapshot Check
      const now = new Date();
      const weekNumber = Math.ceil((now.getDate() + 6 - now.getDay()) / 7);
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const weeklyPath = `datasets/weekly/year_${year}_month_${month}_week_${weekNumber}.json`;

      await octokit.rest.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: weeklyPath,
        message: `📅 Weekly Snapshot: Week ${weekNumber}`,
        content: Buffer.from(JSON.stringify(historyData.slice(-100), null, 2)).toString('base64'),
      }).catch(err => console.error("[GITHUB]: Weekly snapshot skip", err.message));

      console.log("[GITHUB]: Successfully synced detection.");
    } catch (err: any) {
      console.error("[GITHUB]: Sync operation failed internally:", err.message);
    }
  }

  app.use(express.json());

  // API Route to get the latest JSON
  app.get("/json", (req, res) => {
    res.json(lastResult);
  });

  // Export Dataset (CSV)
  app.get("/csv", (req, res) => {
    if (!history || history.length === 0) {
      return res.status(404).json({ 
        error: "NO_DATA", 
        message: "No vehicle detections have been recorded yet." 
      });
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
    try {
      const data = {
        ...req.body,
        server_timestamp: Date.now()
      };
      
      // Basic validation to prevent 500s on malformed input
      if (!data.plate) {
        return res.status(400).json({ error: "INVALID_PAYLOAD: Missing license plate" });
      }

      lastResult = data;
      history.push(data);
      
      // Async Sync (Don't await to keep UI responsive)
      pushToGithub(data).catch(err => {
        console.error("[BACKGROUND_SYNC_ERROR]:", err.message);
      });
      
      res.json({ success: true });
    } catch (err: any) {
      console.error("[SERVER_ERROR]:", err.message);
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
    }
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
