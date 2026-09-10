import fs from 'fs';
import path from 'path';

// Simple file-based persistence for margins and logs
const DB_PATH = path.join(process.cwd(), 'data');
const MARGINS_FILE = path.join(DB_PATH, 'margins.json');
const LOGS_FILE = path.join(DB_PATH, 'logs.json');
const ITEMS_FILE = path.join(DB_PATH, 'items.json');

// Ensure data directory exists
if (!fs.existsSync(DB_PATH)) {
  fs.mkdirSync(DB_PATH, { recursive: true });
}

const FORMATS_FILE = path.join(DB_PATH, 'formats.json');
const ADMINS_FILE = path.join(DB_PATH, 'admins.json');
const SUPPLIER_GAMES_FILE = path.join(DB_PATH, 'supplier_games.json');

export type SupplierGameInfo = {
  url: string;
  detectedAt: string;
  notified: boolean;
};

export type SupplierCatalog = {
  lastSync: string;
  games: Record<string, string>; // gameName -> url
  newDetectedGames: Record<string, SupplierGameInfo>;
};

export type PricelistFormat = {
  header: string;
  footer: string;
  lineSpacing: 'single' | 'double'; // 'double' indicates an extra line between every 2 lines
  itemPrefix?: string;
  customTemplate?: string; // Full raw message layout preserving custom extra lines, section headers, and groupings
};

export type FormatsConfig = {
  global: PricelistFormat;
  games: { [game: string]: Partial<PricelistFormat> };
};

export const DEFAULT_GLOBAL_FORMAT: PricelistFormat = {
  header: '*{game}*',
  footer: '',
  lineSpacing: 'single',
  itemPrefix: ''
};

export type MarginConfig = {
  defaultMargin: number;
  items: { [itemName: string]: number };
  tgPostLink?: string;
};

export type Margins = { [game: string]: MarginConfig };

export type LogEntry = { timestamp: string; message: string; type: 'info' | 'error' | 'alert' };

export type ScrapedItemDetail = { name: string; originalPrice: number; finalPrice: number; profit: number };
export type ScrapedItems = { [game: string]: ScrapedItemDetail[] };

export function getMargins(): Margins {
  if (fs.existsSync(MARGINS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MARGINS_FILE, 'utf8'));
      const migrated: Margins = {};
      for (const key in data) {
        if (typeof data[key] === 'number') {
          migrated[key] = { defaultMargin: data[key], items: {} };
        } else if (data[key] && typeof data[key] === 'object') {
          migrated[key] = {
            defaultMargin: data[key].defaultMargin || 0,
            items: data[key].items || {},
            tgPostLink: data[key].tgPostLink
          };
        }
      }
      return migrated;
    } catch (e) {
      console.error('Error reading margins file:', e);
    }
  }
  return {};
}

export function updateMarginBulk(updates: { game: string, item?: string, margin: number | null }[]) {
  const margins = getMargins();
  for (const u of updates) {
    if (!margins[u.game]) {
      margins[u.game] = { defaultMargin: 0, items: {} };
    }
    if (u.item) {
      if (u.margin === null) {
        delete margins[u.game].items[u.item];
      } else {
        margins[u.game].items[u.item] = u.margin;
      }
    } else {
      if (u.margin !== null) {
        margins[u.game].defaultMargin = u.margin;
        // Overwrite all item-specific margins when setting game default
        margins[u.game].items = {}; 
      }
    }
    // Acknowledge new game if it was in newDetectedGames
    acknowledgeNewGame(u.game);
  }
  fs.writeFileSync(MARGINS_FILE, JSON.stringify(margins, null, 2));
}

export function updateGamePostLink(game: string, link: string) {
  const margins = getMargins();
  if (!margins[game]) {
    margins[game] = { defaultMargin: 10, items: {} }; // Auto-init
  }
  if (link.trim() === '') {
    delete margins[game].tgPostLink;
  } else {
    margins[game].tgPostLink = link.trim();
  }
  fs.writeFileSync(MARGINS_FILE, JSON.stringify(margins, null, 2));
}

export function removeGameEverywhere(game: string): {
  removedFromMargins: boolean;
  removedFromItems: boolean;
  removedFromFormats: boolean;
  removedFromSupplier: boolean;
} {
  let removedFromMargins = false;
  let removedFromItems = false;
  let removedFromFormats = false;
  let removedFromSupplier = false;

  // 1. Remove from margins
  const margins = getMargins();
  if (margins[game]) {
    delete margins[game];
    fs.writeFileSync(MARGINS_FILE, JSON.stringify(margins, null, 2));
    removedFromMargins = true;
  }

  // 2. Remove from cached items & prices
  const items = getScrapedItems();
  if (items[game]) {
    delete items[game];
    saveScrapedItems(items);
    removedFromItems = true;
  }

  // 3. Remove from custom formats
  const formats = getFormats();
  if (formats.games && formats.games[game]) {
    delete formats.games[game];
    saveFormats(formats);
    removedFromFormats = true;
  }

  // 4. Remove from supplier catalog if discontinued
  const catalog = getSupplierCatalog();
  if (catalog.games && catalog.games[game]) {
    delete catalog.games[game];
    removedFromSupplier = true;
  }
  if (catalog.newDetectedGames && catalog.newDetectedGames[game]) {
    delete catalog.newDetectedGames[game];
    removedFromSupplier = true;
  }
  if (removedFromSupplier) {
    saveSupplierCatalog(catalog);
  }

  addLog(`Game "${game}" removed from database and all configurations.`, 'alert');

  return {
    removedFromMargins,
    removedFromItems,
    removedFromFormats,
    removedFromSupplier
  };
}

export function removeGameConfig(game: string) {
  return removeGameEverywhere(game);
}

// Supplier Catalog Management
export function getSupplierCatalog(): SupplierCatalog {
  const defaultCatalog: SupplierCatalog = {
    lastSync: '',
    games: {},
    newDetectedGames: {}
  };

  if (fs.existsSync(SUPPLIER_GAMES_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SUPPLIER_GAMES_FILE, 'utf8'));
      return {
        lastSync: data.lastSync || '',
        games: data.games || {},
        newDetectedGames: data.newDetectedGames || {}
      };
    } catch (e) {
      console.error('Error reading supplier games file:', e);
    }
  }
  return defaultCatalog;
}

export function saveSupplierCatalog(catalog: SupplierCatalog) {
  fs.writeFileSync(SUPPLIER_GAMES_FILE, JSON.stringify(catalog, null, 2));
}

export function acknowledgeNewGame(game: string) {
  const catalog = getSupplierCatalog();
  let changed = false;
  if (catalog.newDetectedGames) {
    for (const key of Object.keys(catalog.newDetectedGames)) {
      if (key.toLowerCase() === game.toLowerCase() || key === game) {
        delete catalog.newDetectedGames[key];
        changed = true;
      }
    }
  }
  if (changed) {
    saveSupplierCatalog(catalog);
  }
}

export function addNewDetectedGame(game: string, url: string) {
  const catalog = getSupplierCatalog();
  if (!catalog.newDetectedGames) {
    catalog.newDetectedGames = {};
  }
  catalog.newDetectedGames[game] = {
    url,
    detectedAt: new Date().toISOString(),
    notified: true
  };
  if (!catalog.games) {
    catalog.games = {};
  }
  catalog.games[game] = url;
  saveSupplierCatalog(catalog);
}

export function getLogs(): LogEntry[] {
  if (fs.existsSync(LOGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    } catch (e) {
      console.error('Error reading logs file:', e);
    }
  }
  return [];
}

export function addLog(message: string, type: 'info' | 'error' | 'alert' = 'info') {
  const logs = getLogs();
  logs.unshift({ timestamp: new Date().toISOString(), message, type });
  // Keep only the last 100 logs
  if (logs.length > 100) {
    logs.length = 100;
  }
  fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
}

export function getScrapedItems(): ScrapedItems {
  if (fs.existsSync(ITEMS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
    } catch (e) {}
  }
  return {};
}

export function saveScrapedItems(items: ScrapedItems) {
  fs.writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2));
}

// Formats Management
export function getFormats(): FormatsConfig {
  const defaultConfig: FormatsConfig = {
    global: { ...DEFAULT_GLOBAL_FORMAT },
    games: {}
  };

  if (fs.existsSync(FORMATS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(FORMATS_FILE, 'utf8'));
      return {
        global: {
          header: data.global?.header !== undefined ? data.global.header : DEFAULT_GLOBAL_FORMAT.header,
          footer: data.global?.footer !== undefined ? data.global.footer : DEFAULT_GLOBAL_FORMAT.footer,
          lineSpacing: data.global?.lineSpacing === 'double' ? 'double' : 'single',
          itemPrefix: data.global?.itemPrefix || '',
          customTemplate: data.global?.customTemplate || undefined
        },
        games: data.games || {}
      };
    } catch (e) {
      console.error('Error reading formats file:', e);
    }
  }
  return defaultConfig;
}

export function saveFormats(formats: FormatsConfig) {
  fs.writeFileSync(FORMATS_FILE, JSON.stringify(formats, null, 2));
}

export function getEffectiveGameFormat(gameName: string): PricelistFormat {
  const formats = getFormats();
  const gameOverride = formats.games[gameName] || {};
  return {
    header: gameOverride.header !== undefined ? gameOverride.header : formats.global.header,
    footer: gameOverride.footer !== undefined ? gameOverride.footer : formats.global.footer,
    lineSpacing: gameOverride.lineSpacing !== undefined ? gameOverride.lineSpacing : formats.global.lineSpacing,
    itemPrefix: gameOverride.itemPrefix !== undefined ? gameOverride.itemPrefix : (formats.global.itemPrefix || ''),
    customTemplate: gameOverride.customTemplate !== undefined ? gameOverride.customTemplate : formats.global.customTemplate
  };
}

export function updateGlobalFormat(update: Partial<PricelistFormat>): FormatsConfig {
  const formats = getFormats();
  formats.global = {
    ...formats.global,
    ...update
  };
  saveFormats(formats);
  return formats;
}

export function updateGameFormat(gameName: string, update: Partial<PricelistFormat>): FormatsConfig {
  const formats = getFormats();
  formats.games[gameName] = {
    ...(formats.games[gameName] || {}),
    ...update
  };
  saveFormats(formats);
  return formats;
}

export function resetGameFormat(gameName: string): FormatsConfig {
  const formats = getFormats();
  delete formats.games[gameName];
  saveFormats(formats);
  return formats;
}

export function applyGameFormatToAll(gameName: string): FormatsConfig {
  const formats = getFormats();
  const gameFmt = getEffectiveGameFormat(gameName);
  
  // Replace the specific game name in the header with {game} placeholder
  let templateHeader = gameFmt.header;
  if (templateHeader.toLowerCase().includes(gameName.toLowerCase())) {
    const regex = new RegExp(gameName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    templateHeader = templateHeader.replace(regex, '{game}');
  }

  formats.global = {
    header: templateHeader,
    footer: gameFmt.footer,
    lineSpacing: gameFmt.lineSpacing,
    itemPrefix: gameFmt.itemPrefix || ''
  };

  // Preserve the source game's specific format/template, reset other overrides to inherit cleanly
  const sourceGameConfig = formats.games[gameName];
  formats.games = {};
  if (sourceGameConfig) {
    formats.games[gameName] = sourceGameConfig;
  }

  saveFormats(formats);
  return formats;
}

// Admins Management
export function getAdmins(): string[] {
  let list: string[] = [];
  if (fs.existsSync(ADMINS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
      if (Array.isArray(data)) list = data;
      else if (Array.isArray(data.adminIds)) list = data.adminIds;
    } catch (e) {
      console.error('Error reading admins file:', e);
    }
  }
  const envAdmin = process.env.TELEGRAM_ADMIN_ID?.trim();
  if (envAdmin && !list.includes(envAdmin)) {
    list.push(envAdmin);
  }
  return list;
}

export function saveAdmins(admins: string[]) {
  const cleanList = Array.from(new Set(admins.map(a => a.trim()).filter(Boolean)));
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(cleanList, null, 2));
}

export function addAdmin(adminId: string): string[] {
  const admins = getAdmins();
  const clean = adminId.replace(/^@/, '').trim();
  if (clean && !admins.includes(clean)) {
    admins.push(clean);
    saveAdmins(admins);
  }
  return admins;
}

export function removeAdmin(adminId: string): string[] {
  const clean = adminId.replace(/^@/, '').trim();
  const admins = getAdmins().filter(a => a !== clean && a !== `@${clean}`);
  saveAdmins(admins);
  return admins;
}

export function isUserAdmin(userId: string | number, username?: string): boolean {
  const admins = getAdmins();
  if (admins.length === 0) {
    return false;
  }
  const strId = userId.toString();
  const cleanUsername = username ? username.replace(/^@/, '').toLowerCase() : '';

  return admins.some(a => {
    const cleanA = a.replace(/^@/, '').toLowerCase();
    return cleanA === strId || (cleanUsername && cleanA === cleanUsername);
  });
}

