import React, { useState, useEffect } from 'react';
import { Settings, RefreshCw, AlertTriangle, Info, Bell, Gamepad2, Percent, ChevronDown, ChevronRight, Trash2, Globe, ExternalLink, Sparkles, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type MarginConfig = {
  defaultMargin: number;
  items: Record<string, number>;
  tgPostLink?: string;
};

type Margins = Record<string, MarginConfig>;
type ScrapedItemDetail = { name: string; originalPrice: number; finalPrice: number; profit: number };
type ScrapedItems = Record<string, ScrapedItemDetail[]>;
type LogEntry = { timestamp: string; message: string; type: 'info' | 'error' | 'alert' };
type SupplierGameInfo = { url: string; detectedAt: string; notified: boolean };
type SupplierCatalog = {
  lastSync: string;
  games: Record<string, string>;
  newDetectedGames: Record<string, SupplierGameInfo>;
};

export default function App() {
  const [margins, setMargins] = useState<Margins>({});
  const [items, setItems] = useState<ScrapedItems>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [availableGames, setAvailableGames] = useState<string[]>([]);
  const [supplierCatalog, setSupplierCatalog] = useState<SupplierCatalog | null>(null);
  const [newGame, setNewGame] = useState('');
  const [newMargin, setNewMargin] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [isSyncingSupplier, setIsSyncingSupplier] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  // Bulk Edit State
  const [selectedGames, setSelectedGames] = useState<Set<string>>(new Set());
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [bulkMargin, setBulkMargin] = useState('');

  const [expandedGames, setExpandedGames] = useState<Set<string>>(new Set());

  const fetchDashboardData = async () => {
    try {
      const [gamesRes, marginsRes, logsRes, itemsRes, catalogRes] = await Promise.all([
        fetch('/api/games'),
        fetch('/api/margins'),
        fetch('/api/logs'),
        fetch('/api/items'),
        fetch('/api/supplier/catalog')
      ]);

      if (gamesRes.ok) setAvailableGames(await gamesRes.json());
      if (marginsRes.ok) setMargins(await marginsRes.json());
      if (logsRes.ok) setLogs(await logsRes.json());
      if (itemsRes.ok) setItems(await itemsRes.json());
      if (catalogRes.ok) setSupplierCatalog(await catalogRes.json());
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
    }
  };

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 10000); // Auto-sync every 10s
    return () => clearInterval(interval);
  }, []);

  const handleSyncSupplier = async () => {
    setIsSyncingSupplier(true);
    setStatusMessage('Scanning supplier catalog at 2gethermart.com...');
    try {
      const res = await fetch('/api/supplier/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setSupplierCatalog(data.catalog);
        const { totalLive, newGames, deletedGames } = data.result;
        setStatusMessage(
          `Supplier sync complete: ${totalLive} live games scanned. ` +
          `(${newGames.length} new detected, ${deletedGames.length} discontinued removed)`
        );
        await fetchDashboardData();
      } else {
        setStatusMessage(`Supplier sync failed: ${data.error}`);
      }
    } catch (error) {
      setStatusMessage('Network error checking supplier website.');
    } finally {
      setIsSyncingSupplier(false);
      setTimeout(() => setStatusMessage(''), 7000);
    }
  };

  const handleDismissNewGame = async (gameName: string) => {
    try {
      const res = await fetch('/api/supplier/dismiss-new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: gameName })
      });
      if (res.ok) {
        const data = await res.json();
        setSupplierCatalog(data.catalog);
      }
    } catch (error) {
      console.error('Failed to dismiss new game notification:', error);
    }
  };

  const handleUpdatePostLink = async (game: string, link: string) => {
    try {
      const res = await fetch('/api/margins/post-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, link })
      });
      if (res.ok) {
        const data = await res.json();
        setMargins(data.margins);
        setStatusMessage(`Updated Telegram post link for ${game}`);
        setTimeout(() => setStatusMessage(''), 3000);
      }
    } catch (error) {
      console.error('Failed to update post link:', error);
    }
  };

  const handleUpdateMargin = async (game: string, marginStr: string, item?: string) => {
    let margin: number | null = null;
    if (marginStr.trim() !== '') {
      margin = parseFloat(marginStr);
      if (isNaN(margin)) return;
    }

    try {
      const res = await fetch('/api/margins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [{ game, margin, item }] })
      });
      if (res.ok) {
        const data = await res.json();
        setMargins(data.margins);
        if (game === newGame && !item) {
           setNewGame('');
           setNewMargin('');
        }
      }
    } catch (error) {
      console.error('Failed to update margin:', error);
    }
  };

  const handleBulkUpdate = async () => {
    const margin = parseFloat(bulkMargin);
    if (isNaN(margin)) return;

    const updates: { game: string; margin: number; item?: string }[] = [];

    // Add game-level updates
    selectedGames.forEach(game => {
      updates.push({ game, margin });
    });

    // Add item-level updates
    selectedItems.forEach(id => {
      const [game, item] = id.split('::');
      updates.push({ game, item, margin });
    });

    if (updates.length === 0) return;

    try {
      const res = await fetch('/api/margins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      if (res.ok) {
        const data = await res.json();
        setMargins(data.margins);
        setSelectedGames(new Set());
        setSelectedItems(new Set());
        setBulkMargin('');
        setStatusMessage('Bulk update applied successfully.');
        setTimeout(() => setStatusMessage(''), 3000);
      }
    } catch (error) {
      console.error('Failed to update margins bulk:', error);
    }
  };

  const handleDeleteGame = async (game: string) => {
    if (!confirm(`Are you sure you want to completely remove ${game} from database and all configurations?`)) return;
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game)}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        setMargins(data.margins);
        if (data.items) setItems(data.items);
        setStatusMessage(`Removed ${game} from database and all configurations.`);
        setTimeout(() => setStatusMessage(''), 4000);
        fetchDashboardData();
      }
    } catch (error) {
      console.error('Failed to delete game:', error);
    }
  };

  const handleManualScrape = async (forceSend: boolean, game?: string) => {
    setIsScraping(true);
    setStatusMessage(`Scraping initiated (${game ? `single game: ${game}` : forceSend ? 'sending all games' : 'sending updates only'})...`);
    try {
      const res = await fetch('/api/scrape', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceSend, game })
      });
      const data = await res.json();
      if (data.success) {
        setStatusMessage(data.message || 'Scraping triggered and broadcasted successfully.');
        setTimeout(fetchDashboardData, 2000); 
      } else {
        setStatusMessage(`Scraping failed: ${data.error}`);
      }
    } catch (error) {
       setStatusMessage('Network error triggering scrape.');
    } finally {
      setIsScraping(false);
      setTimeout(() => setStatusMessage(''), 5000);
    }
  };

  const toggleExpanded = (game: string) => {
    const next = new Set(expandedGames);
    if (next.has(game)) next.delete(game);
    else next.add(game);
    setExpandedGames(next);
  };

  const toggleGameSelection = (game: string, isChecked: boolean) => {
    const nextGames = new Set(selectedGames);
    const nextItems = new Set(selectedItems);
    
    if (isChecked) {
      nextGames.add(game);
      // Select all items for this game
      if (items[game]) {
        items[game].forEach(item => nextItems.add(`${game}::${item.name}`));
      }
    } else {
      nextGames.delete(game);
      // Deselect all items for this game
      if (items[game]) {
        items[game].forEach(item => nextItems.delete(`${game}::${item.name}`));
      }
    }
    
    setSelectedGames(nextGames);
    setSelectedItems(nextItems);
  };

  const toggleItemSelection = (game: string, item: string, isChecked: boolean) => {
    const nextItems = new Set(selectedItems);
    const id = `${game}::${item}`;
    if (isChecked) {
      nextItems.add(id);
    } else {
      nextItems.delete(id);
      // If an item is deselected, also deselect the game bulk selection
      const nextGames = new Set(selectedGames);
      nextGames.delete(game);
      setSelectedGames(nextGames);
    }
    setSelectedItems(nextItems);
  };

  const getLogIcon = (type: string) => {
    switch (type) {
      case 'error': return <AlertTriangle className="w-4 h-4 text-red-500" />;
      case 'alert': return <Bell className="w-4 h-4 text-amber-500" />;
      default: return <Info className="w-4 h-4 text-blue-500" />;
    }
  };

  const totalSelected = selectedGames.size + selectedItems.size;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-indigo-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-10">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-neutral-900">Scraper Admin</h1>
            <p className="text-neutral-500 mt-1">Manage profit margins, monitor automated pricing, and track supplier catalog.</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSyncSupplier}
              disabled={isSyncingSupplier}
              className="flex items-center gap-2 bg-white border border-neutral-300 text-neutral-800 px-4 py-2.5 rounded-lg hover:bg-neutral-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-xs text-sm"
              title="Scan 2gethermart.com to detect new games or remove discontinued ones"
            >
              <Globe className={`w-4 h-4 text-indigo-600 ${isSyncingSupplier ? 'animate-spin' : ''}`} />
              {isSyncingSupplier ? 'Scanning Supplier...' : 'Check Supplier Games'}
            </button>
            <button
              onClick={() => handleManualScrape(false)}
              disabled={isScraping}
              className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-sm text-sm"
              title="Scrape and broadcast only games with price changes"
            >
              <RefreshCw className={`w-4 h-4 ${isScraping ? 'animate-spin' : ''}`} />
              {isScraping ? 'Scraping...' : 'Send Updates Only'}
            </button>
            <button
              onClick={() => handleManualScrape(true)}
              disabled={isScraping}
              className="flex items-center gap-2 bg-neutral-900 text-white px-4 py-2.5 rounded-lg hover:bg-neutral-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-sm text-sm"
              title="Scrape and broadcast all configured games"
            >
              <RefreshCw className={`w-4 h-4 ${isScraping ? 'animate-spin' : ''}`} />
              {isScraping ? 'Scraping...' : 'Send All Latest Games'}
            </button>
          </div>
        </header>

        {/* New Supplier Games Alert Banner */}
        {supplierCatalog && Object.keys(supplierCatalog.newDetectedGames || {}).length > 0 && (
          <div className="mb-8 p-5 bg-amber-50/90 border border-amber-200 rounded-2xl shadow-xs">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex items-center gap-2.5 text-amber-950 font-semibold">
                <Bell className="w-5 h-5 text-amber-600" />
                <span>New Games Detected from Supplier Website (2gethermart.com)</span>
                <span className="bg-amber-200 text-amber-900 text-xs px-2.5 py-0.5 rounded-full font-bold">
                  {Object.keys(supplierCatalog.newDetectedGames).length} New
                </span>
              </div>
            </div>
            <p className="text-xs sm:text-sm text-amber-900/80 mb-4">
              The supplier updated their game catalog! The bot detected these new games and reminded the admin. Add them with your desired profit margin to start scraping prices:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {(Object.entries(supplierCatalog.newDetectedGames) as [string, SupplierGameInfo][]).map(([gameName, info]) => (
                <div key={gameName} className="p-3 bg-white border border-amber-200 rounded-xl shadow-xs flex flex-col justify-between">
                  <div className="mb-2">
                    <span className="font-semibold text-neutral-900 text-sm block truncate">{gameName}</span>
                    <a 
                      href={info.url} 
                      target="_blank" 
                      rel="noreferrer" 
                      className="text-xs text-indigo-600 hover:underline flex items-center gap-1 truncate mt-0.5"
                    >
                      <span className="truncate">{info.url}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </div>
                  <div className="flex items-center gap-2 pt-2 border-t border-neutral-100">
                    <button
                      onClick={() => {
                        setNewGame(gameName);
                        setNewMargin('10');
                      }}
                      className="flex-1 py-1.5 px-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      ➕ Quick Add (10%)
                    </button>
                    <button
                      onClick={() => handleDismissNewGame(gameName)}
                      className="py-1.5 px-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-600 rounded-lg text-xs font-medium transition-colors"
                      title="Dismiss notification"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <AnimatePresence>
            {statusMessage && (
                <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mb-8 p-4 bg-indigo-50 border border-indigo-100 text-indigo-700 rounded-lg flex items-center gap-3"
                >
                    <Info className="w-5 h-5" />
                    {statusMessage}
                </motion.div>
            )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Margins Panel */}
          <div className="lg:col-span-2 space-y-6">
            <section className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
              <div className="p-6 border-b border-neutral-100 flex items-center gap-3">
                <Settings className="w-5 h-5 text-neutral-400" />
                <h2 className="text-lg font-semibold text-neutral-900">Profit Margins (%)</h2>
              </div>
              <div className="p-6">
                
                {/* Add New Game */}
                <div className="flex flex-col sm:flex-row gap-4 mb-8 p-4 bg-neutral-50 rounded-xl border border-neutral-100">
                  <div className="flex-1">
                    <label className="block text-xs font-medium text-neutral-500 mb-1.5 uppercase tracking-wider">Add Game / Category</label>
                    <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <Gamepad2 className="w-4 h-4 text-neutral-400" />
                        </div>
                        <input 
                        type="text" 
                        value={newGame}
                        onChange={(e) => setNewGame(e.target.value)}
                        placeholder="e.g. Mobile Legends: Bang Bang"
                        list="available-games-list"
                        className="w-full pl-10 pr-4 py-2.5 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                        />
                        <datalist id="available-games-list">
                          {availableGames.map(game => (
                            <option key={game} value={game} />
                          ))}
                        </datalist>
                    </div>
                  </div>
                  <div className="w-full sm:w-32">
                    <label className="block text-xs font-medium text-neutral-500 mb-1.5 uppercase tracking-wider">Margin</label>
                     <div className="relative">
                         <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <Percent className="w-4 h-4 text-neutral-400" />
                        </div>
                        <input 
                        type="number" 
                        value={newMargin}
                        onChange={(e) => setNewMargin(e.target.value)}
                        placeholder="15"
                        className="w-full pl-9 pr-4 py-2.5 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                        />
                    </div>
                  </div>
                  <div className="flex items-end">
                    <button 
                      onClick={() => handleUpdateMargin(newGame, newMargin)}
                      disabled={!newGame || !newMargin}
                      className="h-[46px] w-full sm:w-auto px-6 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    >
                      Add
                    </button>
                  </div>
                </div>

                {/* Bulk Actions */}
                <AnimatePresence>
                  {totalSelected > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mb-6 overflow-hidden"
                    >
                      <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <span className="text-sm font-medium text-indigo-900">
                          {totalSelected} item{totalSelected !== 1 ? 's' : ''} selected
                        </span>
                        <div className="flex items-center gap-3">
                          <input 
                            type="number" 
                            value={bulkMargin}
                            onChange={e => setBulkMargin(e.target.value)}
                            placeholder="Margin %"
                            className="w-28 px-3 py-2 bg-white border border-indigo-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-sm"
                          />
                          <button
                            onClick={handleBulkUpdate}
                            disabled={!bulkMargin}
                            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                          >
                            Apply to Selected
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* List */}
                <div className="space-y-3">
                  {(Object.entries(margins) as [string, MarginConfig][]).map(([game, config]) => (
                    <div key={game} className="border border-neutral-100 rounded-xl overflow-hidden bg-white">
                      {/* Game Row */}
                      <div className="flex items-center justify-between p-4 hover:bg-neutral-50/50 transition-colors group">
                        <div className="flex items-center gap-3">
                           <input 
                             type="checkbox"
                             checked={selectedGames.has(game)}
                             onChange={(e) => toggleGameSelection(game, e.target.checked)}
                             className="w-4 h-4 text-indigo-600 rounded border-neutral-300 focus:ring-indigo-500"
                           />
                           <button 
                              onClick={() => toggleExpanded(game)}
                              className="flex items-center gap-2 text-left"
                            >
                             {expandedGames.has(game) ? <ChevronDown className="w-4 h-4 text-neutral-400" /> : <ChevronRight className="w-4 h-4 text-neutral-400" />}
                             <span className="font-medium text-neutral-700">{game}</span>
                           </button>
                           <button
                             onClick={(e) => { e.stopPropagation(); handleManualScrape(true, game); }}
                             disabled={isScraping}
                             className="ml-2 p-1.5 text-neutral-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors disabled:opacity-50 flex items-center gap-1 text-xs font-medium"
                             title="Scrape and send this specific game"
                           >
                             <RefreshCw className={`w-3.5 h-3.5 ${isScraping ? 'animate-spin' : ''}`} />
                             Scrape
                           </button>
                        </div>
                        <div className="flex items-center gap-3">
                          <input 
                            type="number" 
                            defaultValue={config.defaultMargin}
                            onBlur={(e) => handleUpdateMargin(game, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleUpdateMargin(game, e.currentTarget.value);
                                e.currentTarget.blur();
                              }
                            }}
                            placeholder="Default"
                            title="Default margin for this game"
                            className="w-24 px-3 py-1.5 text-right border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-white"
                          />
                          <span className="text-neutral-400 font-medium">%</span>
                          <button 
                            onClick={() => handleDeleteGame(game)}
                            className="p-1.5 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Items List */}
                      <AnimatePresence>
                        {expandedGames.has(game) && (
                          <motion.div
                            initial={{ height: 0 }}
                            animate={{ height: 'auto' }}
                            exit={{ height: 0 }}
                            className="overflow-hidden bg-neutral-50 border-t border-neutral-100"
                          >
                            <div className="p-4 space-y-4">
                              <div className="flex flex-col gap-1.5 pb-3 border-b border-neutral-200">
                                <label className="text-sm font-medium text-neutral-700 flex items-center gap-2">
                                  <span>Telegram Channel Post Link</span>
                                  <span className="text-xs font-normal text-neutral-400">(Auto-edits this post instead of broadcasting)</span>
                                </label>
                                <div className="flex items-center gap-2">
                                  <input 
                                    type="text" 
                                    defaultValue={config.tgPostLink || ''}
                                    placeholder="e.g. https://t.me/mychannel/123"
                                    onBlur={(e) => handleUpdatePostLink(game, e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        handleUpdatePostLink(game, e.currentTarget.value);
                                        e.currentTarget.blur();
                                      }
                                    }}
                                    className="w-full sm:w-2/3 px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                                  />
                                </div>
                              </div>
                              <div className="space-y-2">
                                {items[game] && items[game].length > 0 ? (
                                items[game].map(item => {
                                  const itemMargin = config.items[item.name] !== undefined ? config.items[item.name] : config.defaultMargin;
                                  const displayFinalPrice = Math.round((item.originalPrice * (1 + (itemMargin / 100))) / 50) * 50;
                                  const displayProfit = displayFinalPrice - item.originalPrice;

                                  return (
                                  <div key={item.name} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-neutral-100 transition-colors">
                                    <div className="flex items-center gap-3">
                                      <input 
                                        type="checkbox"
                                        checked={selectedItems.has(`${game}::${item.name}`)}
                                        onChange={(e) => toggleItemSelection(game, item.name, e.target.checked)}
                                        className="w-4 h-4 text-indigo-600 rounded border-neutral-300 focus:ring-indigo-500"
                                      />
                                      <div className="flex flex-col">
                                          <span className="text-sm font-medium text-neutral-700">{item.name}</span>
                                          {item.originalPrice > 0 && (
                                              <div className="flex items-center gap-2 text-xs text-neutral-500 mt-0.5">
                                                  <span className="line-through opacity-70">{item.originalPrice.toLocaleString()} ks</span>
                                                  <span className="text-emerald-600 font-medium">+{displayProfit.toLocaleString()} ks profit</span>
                                                  <span className="text-neutral-900 font-bold ml-1">{displayFinalPrice.toLocaleString()} ks</span>
                                              </div>
                                          )}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <input 
                                        type="number" 
                                        defaultValue={config.items[item.name] ?? ''}
                                        onBlur={(e) => handleUpdateMargin(game, e.target.value, item.name)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            handleUpdateMargin(game, e.currentTarget.value, item.name);
                                            e.currentTarget.blur();
                                          }
                                        }}
                                        placeholder={config.defaultMargin.toString()}
                                        className="w-20 px-2 py-1 text-right text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white placeholder-neutral-300"
                                      />
                                      <span className="text-xs text-neutral-400">%</span>
                                    </div>
                                  </div>
                                );
                                })
                              ) : (
                                <div className="text-sm text-neutral-400 text-center py-4">
                                  No items found yet. Trigger a scrape to populate.
                                </div>
                              )}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ))}
                  
                  {Object.keys(margins).length === 0 && (
                      <div className="text-center py-12 text-neutral-400">
                          No margins configured yet.
                      </div>
                  )}
                </div>

              </div>
            </section>
          </div>

          {/* Activity Logs */}
          <div className="lg:col-span-1">
             <section className="bg-white rounded-2xl shadow-sm border border-neutral-200 h-full flex flex-col">
              <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-white rounded-t-2xl z-10 sticky top-0">
                <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
                    System Logs
                </h2>
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                    Live
                </div>
              </div>
              <div className="p-6 overflow-y-auto flex-1 max-h-[600px]">
                 <div className="space-y-4">
                    <AnimatePresence initial={false}>
                        {logs.map((log, i) => (
                        <motion.div 
                            key={i}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="flex gap-3 items-start p-3 rounded-lg hover:bg-neutral-50 transition-colors"
                        >
                            <div className="mt-0.5">
                                {getLogIcon(log.type)}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-neutral-700 leading-snug break-words">
                                    {log.message}
                                </p>
                                <span className="text-xs text-neutral-400 mt-1 block">
                                    {new Date(log.timestamp).toLocaleTimeString()}
                                </span>
                            </div>
                        </motion.div>
                        ))}
                    </AnimatePresence>
                    {logs.length === 0 && (
                         <div className="text-center py-12 text-neutral-400 text-sm">
                         System is idle.
                     </div>
                    )}
                 </div>
              </div>
            </section>
          </div>

        </div>
      </div>
    </div>
  );
}
