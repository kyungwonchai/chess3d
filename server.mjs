import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10210;

app.use(cors());
app.use(express.json());

// Health check endpoint
const healthHandler = (req, res) => {
  res.json({
    status: 'ok',
    service: 'chess3d',
    title: 'Wizard Chess 3D',
    time: new Date().toISOString()
  });
};

app.get('/api/health', healthHandler);
app.get('/chess3d/api/health', healthHandler);

// Static assets serving (Dual routing: /chess3d and /)
const distPath = path.join(__dirname, 'dist');

if (fs.existsSync(distPath)) {
  app.use('/chess3d', express.static(distPath));
  app.use(express.static(distPath));

  // Catch-all fallback for SPA
  app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  console.warn('⚠️ dist directory not found! Run npm run build first.');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`♟️ Wizard Chess 3D Server running on port ${PORT}`);
  console.log(`🔗 Local URL:  http://localhost:${PORT}/chess3d/`);
  console.log(`🌐 DuckDNS:    https://kwopi.duckdns.org/chess3d/`);
  console.log(`=================================================`);
});
