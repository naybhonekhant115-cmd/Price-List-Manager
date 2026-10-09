import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { scrapePrices, initBot, triggerManualScrape, GAME_URLS, syncSupplierCatalog } from './server/bot.js';
import { 
  getMargins, 
  updateMarginBulk, 
  removeGameConfig, 
  getLogs, 
  addLog, 
  getScrapedItems,
  getFormats,
  updateGlobalFormat,
  updateGameFormat,
  resetGameFormat,
  applyGameFormatToAll,
  getAdmins,
  addAdmin,
  removeAdmin,
  getSupplierCatalog,
  saveSupplierCatalog,
  removeGameEverywhere,
  acknowledgeNewGame,
  updateGamePostLink
} from './server/db.js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get('/api/games', (req, res) => {
    const catalog = getSupplierCatalog();
    const allGames = Array.from(new Set([
      ...Object.keys(catalog.games || {}),
      ...Object.keys(GAME_URLS),
      ...Object.keys(getMargins())
    ])).sort();
    res.json(allGames);
  });

  app.get('/api/margins', (req, res) => {
    res.json(getMargins());
  });

  app.post('/api/margins', (req, res) => {
    const { updates } = req.body;
    
    if (Array.isArray(updates)) {
      updateMarginBulk(updates);
      res.json({ success: true, margins: getMargins() });
    } else {
      res.status(400).json({ error: 'Expected updates array' });
    }
  });

  app.post('/api/margins/post-link', (req, res) => {
    const { game, link } = req.body;
    if (typeof game === 'string' && typeof link === 'string') {
      updateGamePostLink(game, link);
      res.json({ success: true, margins: getMargins() });
    } else {
      res.status(400).json({ error: 'Expected game and link strings' });
    }
  });

  app.delete('/api/margins/:game', (req, res) => {
    removeGameEverywhere(req.params.game);
    res.json({ success: true, margins: getMargins(), items: getScrapedItems(), formats: getFormats() });
  });

  app.delete('/api/games/:game', (req, res) => {
    removeGameEverywhere(req.params.game);
    res.json({ success: true, margins: getMargins(), items: getScrapedItems(), formats: getFormats() });
  });

  // Supplier Catalog Routes
  app.get('/api/supplier/catalog', (req, res) => {
    res.json(getSupplierCatalog());
  });

  app.post('/api/supplier/sync', async (req, res) => {
    try {
      const result = await syncSupplierCatalog();
      res.json({ success: true, result, catalog: getSupplierCatalog() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/supplier/dismiss-new', (req, res) => {
    const { game } = req.body;
    if (game && typeof game === 'string') {
      acknowledgeNewGame(game);
      res.json({ success: true, catalog: getSupplierCatalog() });
    } else {
      res.status(400).json({ error: 'Valid game name required' });
    }
  });

  app.get('/api/items', (req, res) => {
    res.json(getScrapedItems());
  });

  app.get('/api/logs', (req, res) => {
    res.json(getLogs());
  });

  // Formats Routes
  app.get('/api/formats', (req, res) => {
    res.json(getFormats());
  });

  app.post('/api/formats/global', (req, res) => {
    const { header, footer, lineSpacing, itemPrefix, customTemplate } = req.body;
    const updated = updateGlobalFormat({ header, footer, lineSpacing, itemPrefix, customTemplate });
    res.json({ success: true, formats: updated });
  });

  app.post('/api/formats/game/:game', (req, res) => {
    const { header, footer, lineSpacing, itemPrefix, customTemplate } = req.body;
    const updated = updateGameFormat(req.params.game, { header, footer, lineSpacing, itemPrefix, customTemplate });
    res.json({ success: true, formats: updated });
  });

  app.delete('/api/formats/game/:game', (req, res) => {
    const updated = resetGameFormat(req.params.game);
    res.json({ success: true, formats: updated });
  });

  app.post('/api/formats/apply-all/:game', (req, res) => {
    const updated = applyGameFormatToAll(req.params.game);
    res.json({ success: true, formats: updated });
  });

  // Admins Routes
  app.get('/api/admins', (req, res) => {
    res.json(getAdmins());
  });

  app.post('/api/admins', (req, res) => {
    const { adminId } = req.body;
    if (adminId && typeof adminId === 'string') {
      const updated = addAdmin(adminId);
      res.json({ success: true, admins: updated });
    } else {
      res.status(400).json({ error: 'Valid adminId required' });
    }
  });

  app.delete('/api/admins/:adminId', (req, res) => {
    const updated = removeAdmin(req.params.adminId);
    res.json({ success: true, admins: updated });
  });

  app.post('/api/scrape', async (req, res) => {
    try {
      const forceSend = req.body?.forceSend ?? true;
      const game = req.body?.game;
      await triggerManualScrape(forceSend, game);
      res.json({ success: true, message: `Scraping triggered manually (forceSend: ${forceSend}${game ? `, game: ${game}` : ''})` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Initialize bot and scraper
  addLog(`Server starting up. Token exists: ${!!process.env.TELEGRAM_BOT_TOKEN}`, 'info');
  if (process.env.TELEGRAM_BOT_TOKEN) {
    initBot();
  } else {
    console.warn('TELEGRAM_BOT_TOKEN is not set. Bot and scraper will not run.');
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
