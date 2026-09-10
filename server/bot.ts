import { Telegraf, Markup } from 'telegraf';
import { chromium } from 'playwright';
import cron from 'node-cron';
import { 
  getMargins, 
  addLog, 
  getScrapedItems, 
  saveScrapedItems,
  getFormats,
  getEffectiveGameFormat,
  updateGlobalFormat,
  updateGameFormat,
  resetGameFormat,
  applyGameFormatToAll,
  getAdmins,
  addAdmin,
  isUserAdmin,
  PricelistFormat,
  getSupplierCatalog,
  saveSupplierCatalog,
  removeGameEverywhere,
  acknowledgeNewGame,
  addNewDetectedGame,
  updateMarginBulk
} from './db.js';

let bot: Telegraf | null = null;
let lastPrices: Record<string, Record<string, string>> = {};

// Track admin interactive editing sessions in Telegram
type UserEditingSession = 
  | { step: 'awaiting_game_format'; game: string }
  | { step: 'awaiting_game_post_link'; game: string }
  | { step: 'awaiting_global_format' }
  | { step: 'awaiting_global_header' }
  | { step: 'awaiting_global_footer' };

const userSessions: Record<string | number, UserEditingSession> = {};

export function renderWithCustomTemplate(
  template: string,
  itemsList: { cleanItem: string; priceNum: string }[],
  lineSpacing?: 'single' | 'double'
): string {
  // Normalize items lookup map
  const priceMap = new Map<string, string>();
  for (const item of itemsList) {
    priceMap.set(item.cleanItem.trim().toLowerCase(), item.priceNum);
  }

  const lines = template.split('\n');
  const renderedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 1. Blank line (extra line between 2 lines): PRESERVE IT!
    if (!trimmed) {
      renderedLines.push('');
      continue;
    }

    // 2. Check if line contains an item price: e.g. "55 - 3,600 ks" or "WP x 2 - 13,700 ks"
    const match = rawLine.match(/^(\s*.*?)([-–—:]\s*)([\d,.]+)(\s*(?:ks|mmk)?.*)$/i);
    if (match) {
      const prefixAndName = match[1];
      const separator = match[2];
      const suffix = match[4];

      let itemCandidate = prefixAndName
        .replace(/^[•▫️▪️🔹🔸▶️>*~\-\s]+/, '')
        .trim()
        .toLowerCase();

      itemCandidate = itemCandidate
        .replace(/weekly pass/ig, 'wp')
        .replace(/twilight pass/ig, 'twilight')
        .replace(/monthly epic bundle/ig, 'monthly')
        .replace(/weekly elite bundle/ig, 'weekly elite');

      let newPrice: string | undefined;
      if (priceMap.has(itemCandidate)) {
        newPrice = priceMap.get(itemCandidate);
      } else {
        for (const [k, p] of priceMap.entries()) {
          if (itemCandidate === k || itemCandidate.startsWith(k) || k.startsWith(itemCandidate)) {
            newPrice = p;
            break;
          }
        }
      }

      if (newPrice) {
        // Format newPrice with commas if it's a number
        const formattedPrice = newPrice.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        renderedLines.push(`${prefixAndName}${separator}${formattedPrice}${suffix}`);
      } else {
        renderedLines.push(rawLine);
      }
    } else {
      // Header, subtitle, section header, footer, notes (e.g. "To buy - @levil_ft_sushitrash")
      renderedLines.push(rawLine);
    }
  }

  // Double spacing: "the extra line between 2 lines"
  if (lineSpacing === 'double') {
    const doubleSpaced: string[] = [];
    for (let i = 0; i < renderedLines.length; i++) {
      doubleSpaced.push(renderedLines[i]);
      if (i < renderedLines.length - 1 && renderedLines[i].trim() !== '' && renderedLines[i + 1].trim() !== '') {
        doubleSpaced.push('');
      }
    }
    return doubleSpaced.join('\n');
  }

  return renderedLines.join('\n');
}

export function formatGameMessage(
  game: string, 
  itemsList: { cleanItem: string; priceNum: string }[], 
  customFormat?: PricelistFormat
): string {
  const fmt = customFormat || getEffectiveGameFormat(game);

  // If a custom template is present, use it to preserve exact extra lines and grouping
  if (fmt.customTemplate && fmt.customTemplate.trim()) {
    return renderWithCustomTemplate(fmt.customTemplate, itemsList, fmt.lineSpacing);
  }

  // Standard generator format
  let header = (fmt.header || '<b>{game}</b>').replace(/\{game\}/gi, game).trim();
  // Line spacing: 'double' means extra blank line between 2 lines (\n\n)
  const itemSeparator = fmt.lineSpacing === 'double' ? '\n\n' : '\n';
  const prefix = fmt.itemPrefix || '';

  const itemsBody = itemsList
    .map(p => `${prefix}${p.cleanItem} - ${p.priceNum} ks`)
    .join(itemSeparator);

  let result = '';
  if (header) {
    // Extra line (blank line) after header so title is not glued to items
    result += header + '\n\n';
  }
  result += itemsBody;
  if (fmt.footer && fmt.footer.trim()) {
    // Extra line (blank line) before footer
    result += '\n\n' + fmt.footer.trim();
  }
  return result;
}

export function getGameItemsSample(game: string): { cleanItem: string; priceNum: string }[] {
  const scraped = getScrapedItems();
  let gameItems = scraped[game];
  if (!gameItems || gameItems.length === 0) {
    for (const key of Object.keys(scraped)) {
      if (key.toLowerCase().includes(game.toLowerCase()) || game.toLowerCase().includes(key.toLowerCase())) {
        gameItems = scraped[key];
        break;
      }
    }
  }
  if (gameItems && gameItems.length > 0) {
    return gameItems.map(item => {
      let cleanItem = item.name.replace(/(?:\s*(?:Diamonds|Gold|Lunites|Monochrome|Devil Gems|Heart Diamond|Heartopia Diamond|Coins|Supplies|UC|Unknown Cash|Diamond))$/i, '');
      cleanItem = cleanItem.replace(/Weekly Pass/ig, 'WP')
                           .replace(/Twilight Pass/ig, 'Twilight')
                           .replace(/Monthly Epic Bundle/ig, 'Monthly')
                           .replace(/Weekly Elite Bundle/ig, 'Weekly Elite');
      return {
        cleanItem,
        priceNum: item.finalPrice ? item.finalPrice.toLocaleString() : '3,850'
      };
    });
  }
  return [
    { cleanItem: '55', priceNum: '3,850' },
    { cleanItem: '165', priceNum: '11,550' },
    { cleanItem: '275', priceNum: '19,250' },
    { cleanItem: 'WP', priceNum: '6,950' },
    { cleanItem: 'Twilight', priceNum: '34,000' }
  ];
}

export function parseModifiedPricelist(text: string, gameName: string): PricelistFormat {
  const lines = text.split('\n');
  const itemPattern = /^(.*?)(\b[\w\s().+xX\-–]+?)\s*[-–—:]\s*([\d,.]+\s*(?:ks|mmk)?.*)$/i;

  let firstItemIndex = -1;
  let lastItemIndex = -1;
  const detectedItemIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/(?:^|\s)[-–—:]\s*[\d,.]+(\s*(?:ks|mmk))?$/i.test(line) || itemPattern.test(line)) {
      if (firstItemIndex === -1) firstItemIndex = i;
      lastItemIndex = i;
      detectedItemIndices.push(i);
    }
  }

  // Fallback if no item pattern found
  if (firstItemIndex === -1) {
    return {
      header: text.trim(),
      footer: '',
      lineSpacing: 'single',
      itemPrefix: '',
      customTemplate: text.trim()
    };
  }

  // Header is all lines before first item
  const header = lines.slice(0, firstItemIndex).join('\n').trim();

  // Footer is all lines after last item
  const footer = lines.slice(lastItemIndex + 1).join('\n').trim();

  // Detect if there is an extra line between EVERY 2 consecutive items
  let consecutiveItemBlanks = 0;
  for (let idx = 0; idx < detectedItemIndices.length - 1; idx++) {
    const curr = detectedItemIndices[idx];
    const next = detectedItemIndices[idx + 1];
    if (next - curr > 1) {
      consecutiveItemBlanks++;
    }
  }
  const isAllDouble = detectedItemIndices.length > 2 && consecutiveItemBlanks >= (detectedItemIndices.length - 1) * 0.8;
  const lineSpacing: 'single' | 'double' = isAllDouble ? 'double' : 'single';

  // Detect item bullet/prefix if any
  let detectedPrefix = '';
  const firstItemLine = lines[firstItemIndex].trim();
  const prefixMatch = firstItemLine.match(/^([•▫️▪️🔹🔸▶️>*~\-]+)\s*/);
  if (prefixMatch) {
    detectedPrefix = prefixMatch[0];
  }

  return {
    header: header || `*${gameName}*`,
    footer,
    lineSpacing,
    itemPrefix: detectedPrefix,
    customTemplate: text.trim()
  };
}

export function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    return;
  }

  try {
    bot = new Telegraf(token);

    // /start command
    bot.command('start', async (ctx) => {
      const userId = ctx.from.id;
      const username = ctx.from.username;
      const isAdmin = isUserAdmin(userId, username);
      const allAdmins = getAdmins();

      if (!isAdmin) {
        if (allAdmins.length === 0) {
          await ctx.reply(
            `👋 *Welcome to Game Pricelist Bot!*\n\nNo Telegram Admin is registered yet.\nTap below to claim admin access for this account (\`${userId}\`):`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('👑 Claim Admin Access', 'claim_admin')]
              ])
            }
          );
          return;
        }
        await ctx.reply(
          `👋 *Hello ${ctx.from.first_name || ''}*\n\nYour Telegram User ID is: \`${userId}\`\n\n⛔️ You are not registered as an authorized admin.\nPlease ask the owner to add your ID in the Web Dashboard or grant you admin rights.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await sendAdminMainMenu(ctx);
    });

    // /admin and /menu commands
    bot.command(['admin', 'menu'], async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) {
        if (getAdmins().length === 0) {
          await ctx.reply(`No admin configured yet. Tap below to claim:`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('👑 Claim Admin Access', 'claim_admin')]])
          });
          return;
        }
        await ctx.reply(`⛔️ Unauthorized. Your Telegram User ID is: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
        return;
      }
      delete userSessions[ctx.from.id];
      await sendAdminMainMenu(ctx);
    });

    // /format command
    bot.command('format', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) {
        await ctx.reply(`⛔️ Unauthorized. Your ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
        return;
      }
      delete userSessions[ctx.from.id];
      await sendFormatMenu(ctx);
    });

    // /myid command
    bot.command('myid', (ctx) => {
      ctx.reply(`🆔 *Your Telegram Info:*\n• User ID: \`${ctx.from.id}\`\n• Username: @${ctx.from.username || 'none'}\n• Admin Status: ${isUserAdmin(ctx.from.id, ctx.from.username) ? '✅ Authorized Admin' : '❌ Standard User'}`, { parse_mode: 'Markdown' });
    });

    // /claimadmin command
    bot.command('claimadmin', (ctx) => {
      const allAdmins = getAdmins();
      if (allAdmins.length === 0) {
        addAdmin(ctx.from.id.toString());
        addLog(`User @${ctx.from.username || ctx.from.id} claimed Telegram Admin rights.`, 'info');
        ctx.reply(`🎉 *You are now the Telegram Bot Admin!*\nYour ID: \`${ctx.from.id}\`\nUse /admin or /format to start.`, { parse_mode: 'Markdown' });
      } else if (isUserAdmin(ctx.from.id, ctx.from.username)) {
        ctx.reply(`You are already an admin.`);
      } else {
        ctx.reply(`⛔️ Admin accounts already exist. Contact the current admin to add \`${ctx.from.id}\`.`);
      }
    });

    // /admins command
    bot.command('admins', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) {
        await ctx.reply('Unauthorized.');
        return;
      }
      const admins = getAdmins();
      await ctx.reply(
        `👥 *Registered Telegram Admins:*\n${admins.map(a => `• \`${a}\``).join('\n') || 'None'}\n\nTo add an admin, use: \`/addadmin <id_or_username>\``,
        { parse_mode: 'Markdown' }
      );
    });

    // /addadmin command
    bot.command('addadmin', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) {
        await ctx.reply('Unauthorized.');
        return;
      }
      const parts = ctx.message.text.split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply('Usage: `/addadmin <userId_or_username>`', { parse_mode: 'Markdown' });
        return;
      }
      const target = parts[1].trim();
      addAdmin(target);
      addLog(`Admin @${ctx.from.username || ctx.from.id} added admin ${target}`, 'info');
      await ctx.reply(`✅ Added \`${target}\` to Telegram Bot Admins.`, { parse_mode: 'Markdown' });
    });

    // /scrape command
    bot.command('scrape', async (ctx) => {
      const chatId = ctx.chat.id;
      const isGroup = process.env.TELEGRAM_GROUP_ID && chatId.toString() === process.env.TELEGRAM_GROUP_ID;
      const isAdmin = isUserAdmin(ctx.from.id, ctx.from.username);
      
      if (!isAdmin && !isGroup) {
        await ctx.reply('Unauthorized.');
        return;
      }
      await ctx.reply('Starting manual scrape and update dispatch...');
      try {
        await triggerManualScrape();
        await ctx.reply('✅ Scrape and price update complete.');
      } catch (e: any) {
        await ctx.reply(`❌ Scrape failed: ${e.message}`);
      }
    });

    bot.command('ping', (ctx) => {
      ctx.reply('Pong! Bot is active.');
    });

    // /checkgames or /syncsupplier command
    bot.command(['checkgames', 'syncsupplier'], async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) {
        await ctx.reply('⛔️ Unauthorized. Only admins can trigger supplier catalog checks.');
        return;
      }
      await ctx.reply('🔍 *Checking supplier catalog online...*\nPlease wait a moment while the bot scans the website.', { parse_mode: 'Markdown' });
      try {
        const res = await syncSupplierCatalog();
        let summary = `🔍 *Supplier Catalog Check Result:*\n\n` +
          `• Total Live Games on Supplier: *${res.totalLive}*\n` +
          `• Discontinued Games Removed: *${res.deletedGames.length}*\n` +
          `• New Games Discovered: *${res.newGames.length}*\n\n`;

        if (res.newGames.length > 0) {
          summary += `🆕 *New Game(s) Detected:*\n` +
            res.newGames.map(g => `• *${g.name}* (<a href="${g.url}">Link</a>)`).join('\n') +
            `\n\n👉 *Reminder:* You can add these games from the website dashboard or via the buttons below to set margins!`;
        }
        if (res.deletedGames.length > 0) {
          summary += `\n\n🗑️ *Discontinued Games (Removed from DB & Tracking):*\n` +
            res.deletedGames.map(g => `• ~${g}~`).join('\n');
        }
        if (res.newGames.length === 0 && res.deletedGames.length === 0) {
          summary += `✅ Database is fully synchronized with supplier catalog!`;
        }

        const buttons: any[] = [];
        if (res.newGames.length > 0) {
          for (const g of res.newGames.slice(0, 4)) {
            buttons.push([Markup.button.callback(`➕ Add ${g.name.slice(0, 18)} (10%)`, `quick_add_game:${g.name}`)]);
          }
        }
        buttons.push([Markup.button.callback('🔙 Back to Main Menu', 'menu_main')]);
        await ctx.reply(summary, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
      } catch (e: any) {
        await ctx.reply(`❌ Supplier sync failed: ${e.message}`);
      }
    });

    // Handle Callbacks
    bot.action('claim_admin', async (ctx) => {
      const allAdmins = getAdmins();
      if (allAdmins.length === 0) {
        addAdmin(ctx.from.id.toString());
        addLog(`User @${ctx.from.username || ctx.from.id} claimed Telegram Admin rights via button.`, 'info');
        await ctx.answerCbQuery('Admin claimed!').catch(() => {});
        await ctx.reply(
          `🎉 *Congratulations!*\n\nYou are now registered as the Telegram Bot Admin (ID: \`${ctx.from.id}\`).\nTap below to open the Admin Panel:`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🛠 Open Admin Panel', 'menu_main')]
            ])
          }
        );
      } else {
        await ctx.answerCbQuery('Admins already registered.', { show_alert: true }).catch(() => {});
      }
    });

    bot.action('menu_main', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) {
        await ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCbQuery().catch(() => {});
      delete userSessions[ctx.from.id];
      await sendAdminMainMenu(ctx);
    });

    bot.action('menu_format', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      delete userSessions[ctx.from.id];
      await sendFormatMenu(ctx);
    });

    bot.action('menu_scrape_updates', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply('⏳ *Starting scrape job...* Gathering prices. Will ONLY broadcast games with changed prices.', { parse_mode: 'Markdown' });
      try {
        await triggerManualScrape(false);
        await ctx.reply('✅ *Scrape finished!* Messages sent to Telegram group for updated games.', { parse_mode: 'Markdown' });
      } catch (e: any) {
        await ctx.reply(`❌ Scrape error: ${e.message}`);
      }
    });

    bot.action('menu_scrape_all', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply('⏳ *Starting scrape job...* Gathering prices. Will broadcast ALL enabled games.', { parse_mode: 'Markdown' });
      try {
        await triggerManualScrape(true);
        await ctx.reply('✅ *Scrape finished!* Messages sent to Telegram group for all games.', { parse_mode: 'Markdown' });
      } catch (e: any) {
        await ctx.reply(`❌ Scrape error: ${e.message}`);
      }
    });

    bot.action('menu_admins', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      const admins = getAdmins();
      const text = `👥 *Telegram Admin Accounts*\n\nRegistered Admins:\n${admins.map(a => `• \`${a}\``).join('\n') || 'None'}\n\nAdmins can change formats, adjust spacing, and trigger scrapes.\n\nTo add an admin in chat:\n\`/addadmin <id_or_username>\``;
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main Menu', 'menu_main')]])
      });
    });

    bot.action('menu_prices', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      const margins = getMargins();
      const games = Object.keys(margins);
      if (games.length === 0) {
        await ctx.reply('No games configured with margins yet. Add games on the Web Dashboard.');
        return;
      }
      let summary = `📋 *Configured Games & Default Margins:*\n\n`;
      for (const g of games) {
        summary += `• *${g}*: +${margins[g].defaultMargin} ks default margin\n`;
      }
      await ctx.reply(summary, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main Menu', 'menu_main')]])
      });
    });

    // Supplier Catalog Management in Bot
    bot.action('menu_check_supplier', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery('Scanning supplier catalog...').catch(() => {});
      await ctx.reply('🔍 *Scanning supplier website for catalog changes...*\nPlease wait a few seconds.', { parse_mode: 'Markdown' });
      try {
        const res = await syncSupplierCatalog();
        let summary = `🔍 *Supplier Catalog Check Result:*\n\n` +
          `• Total Live Games on Supplier: *${res.totalLive}*\n` +
          `• Discontinued Games Removed: *${res.deletedGames.length}*\n` +
          `• New Games Discovered: *${res.newGames.length}*\n\n`;

        if (res.newGames.length > 0) {
          summary += `🆕 *New Game(s) Detected:*\n` +
            res.newGames.map(g => `• *${g.name}* (<a href="${g.url}">Link</a>)`).join('\n') +
            `\n\n👉 *Reminder:* You can add these games from the website dashboard or via buttons below to set profit margins!`;
        }
        if (res.deletedGames.length > 0) {
          summary += `\n\n🗑️ *Discontinued Games (Removed from DB & Tracking):*\n` +
            res.deletedGames.map(g => `• ~${g}~`).join('\n');
        }
        if (res.newGames.length === 0 && res.deletedGames.length === 0) {
          summary += `✅ All games match the supplier catalog. Database is fully up to date!`;
        }

        const buttons: any[] = [];
        if (res.newGames.length > 0) {
          for (const g of res.newGames.slice(0, 4)) {
            buttons.push([Markup.button.callback(`➕ Add ${g.name.slice(0, 18)} (10%)`, `quick_add_game:${g.name}`)]);
          }
        }
        buttons.push([Markup.button.callback('🔙 Back to Main Menu', 'menu_main')]);
        await ctx.reply(summary, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
      } catch (e: any) {
        await ctx.reply(`❌ Supplier sync failed: ${e.message}`);
      }
    });

    bot.action('menu_new_games', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      const catalog = getSupplierCatalog();
      const newGames = catalog.newDetectedGames || {};
      const gameEntries = Object.entries(newGames);

      if (gameEntries.length === 0) {
        await ctx.reply('✅ *No pending new games from supplier.*\nAll detected games have been configured or acknowledged.', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main Menu', 'menu_main')]])
        });
        return;
      }

      let text = `🔔 *New Games Detected on Supplier Website (${gameEntries.length})*\n\nThe following games were detected on the supplier website but have not yet been added to your margins list:\n\n`;
      const buttons: any[] = [];

      for (const [name, info] of gameEntries) {
        text += `🎮 *${name}*\n🔗 ${info.url}\n\n`;
        buttons.push([
          Markup.button.callback(`➕ Add ${name.slice(0, 15)} (10%)`, `quick_add_game:${name}`),
          Markup.button.callback(`❌ Dismiss`, `dismiss_new_game:${name}`)
        ]);
      }
      text += `💡 *Reminder:* You can also add and configure custom per-item margins from the website dashboard!`;
      buttons.push([Markup.button.callback('🔙 Back to Main Menu', 'menu_main')]);

      await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    });

    bot.action(/^quick_add_game:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      updateMarginBulk([{ game: gameName, margin: 10 }]);
      acknowledgeNewGame(gameName);
      addLog(`Admin @${ctx.from.username || ctx.from.id} added new supplier game "${gameName}" via Telegram bot.`, 'info');
      await ctx.answerCbQuery(`Added ${gameName}!`).catch(() => {});
      await ctx.reply(
        `✅ *Game Added Successfully!*\n\n• *Game*: *${gameName}*\n• *Default Margin*: *10%*\n\nLive prices will be scraped and broadcasted automatically on the next cycle.\nYou can adjust item margins anytime on the web dashboard or via /admin.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 View All New Games', 'menu_new_games')],
            [Markup.button.callback('🔙 Main Menu', 'menu_main')]
          ])
        }
      );
    });

    bot.action(/^dismiss_new_game:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      acknowledgeNewGame(gameName);
      await ctx.answerCbQuery(`Dismissed ${gameName}`).catch(() => {});
      await ctx.reply(`Notification dismissed for *${gameName}*. You can still add it anytime from the website dashboard.`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📋 View All New Games', 'menu_new_games')]])
      });
    });

    // Global Format View & Actions
    bot.action('fmt_global', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      delete userSessions[ctx.from.id];
      await sendGlobalFormatMenu(ctx);
    });

    bot.action('fmt_global_toggle_spacing', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const formats = getFormats();
      const nextSpacing = formats.global.lineSpacing === 'single' ? 'double' : 'single';
      updateGlobalFormat({ lineSpacing: nextSpacing });
      await ctx.answerCbQuery(`Global line spacing set to ${nextSpacing}`).catch(() => {});
      await sendGlobalFormatMenu(ctx);
    });

    bot.action('fmt_global_sample', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});

      const sampleGame = 'Mobile Legends: Bang Bang';
      const items = getGameItemsSample(sampleGame);
      const sampleText = formatGameMessage(sampleGame, items, getFormats().global);

      userSessions[ctx.from.id] = { step: 'awaiting_global_format' };

      await ctx.reply(`📋 *Current Global Format Sample (All Games):*\n\n\`\`\`\n${sampleText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\`\`\``, { parse_mode: 'Markdown' });
      await ctx.reply(sampleText, { parse_mode: 'HTML' }).catch(() => ctx.reply(sampleText));
      await ctx.reply(
        `✏️ *How to modify Global Format for All Games:*\n\n` +
        `1️⃣ *Copy* the message above.\n` +
        `2️⃣ *Edit* your desired Header, Footer, or Line Spacing.\n` +
        `3️⃣ *Send or reply* with your modified version right here!\n\n` +
        `💡 *Tip*: The bot will automatically detect your header (before the numbers), footer (after the numbers), and whether you used single or double spacing between lines.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'fmt_global')]])
        }
      );
    });

    bot.action('fmt_global_set_header', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      userSessions[ctx.from.id] = { step: 'awaiting_global_header' };
      await ctx.reply(
        `✏️ *Set Global Header Template*\n\nPlease send the text you would like at the top of every pricelist message.\n\n*Tip*: You can use \`{game}\` where you want the specific game's title to appear (e.g. \`🔥 {game} 🔥\\n⚡ Instant Delivery\`).`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'fmt_global')]])
        }
      );
    });

    bot.action('fmt_global_set_footer', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      userSessions[ctx.from.id] = { step: 'awaiting_global_footer' };
      await ctx.reply(
        `✏️ *Set Global Footer Template*\n\nPlease send the text you would like at the bottom of every pricelist message (e.g. contact info, order terms, payment details).\n\nSend \`clear\` to remove footer.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'fmt_global')]])
        }
      );
    });

    bot.action('fmt_global_reset', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      updateGlobalFormat({ header: '*{game}*', footer: '', lineSpacing: 'single', itemPrefix: '' });
      await ctx.answerCbQuery('Global format reset to default').catch(() => {});
      await sendGlobalFormatMenu(ctx);
    });

    // Individual Game Selector
    bot.action('fmt_indiv_select', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      delete userSessions[ctx.from.id];
      await sendIndividualGamesSelect(ctx, 0);
    });

    bot.action(/^fmt_page:(\d+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      const page = parseInt(ctx.match[1], 10) || 0;
      await sendIndividualGamesSelect(ctx, page);
    });

    // INDIVIDUAL GAME MODE - User clicks game name on option menu
    // "the bot send the repo, and admin will send the modified version of price list"
    bot.action(/^fmt_game:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      const items = getGameItemsSample(gameName);
      const currentFormat = getEffectiveGameFormat(gameName);
      const sampleMessage = formatGameMessage(gameName, items, currentFormat);

      // Set user session to await their modified version
      userSessions[ctx.from.id] = {
        step: 'awaiting_game_format',
        game: gameName
      };

      await ctx.answerCbQuery().catch(() => {});

      // 1. Send the repo / formatted price list
      await ctx.reply(`📋 *Current Pricelist for ${gameName}:*\n\n\`\`\`\n${sampleMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\`\`\``, { parse_mode: 'Markdown' });

      // 2. Also send it directly as normal copyable text
      await ctx.reply(sampleMessage, { parse_mode: 'HTML' }).catch(() => ctx.reply(sampleMessage));

      // 3. Send instructions and option controls
      const isDouble = currentFormat.lineSpacing === 'double';
      const instructionText = `✏️ *Format Editor for ${gameName}*

The message above is the current pricelist for *${gameName}*.

*To change the format:*
1️⃣ *Copy* the message above.
2️⃣ *Modify* the **Header**, **Footer**, **Emojis**, or **Line Spacing** (keep the items/numbers in place).
3️⃣ *Send or reply* with your modified version!

*(The bot will automatically extract your new header, spacing, and footer for this game).*

💡 Or use quick action buttons below:`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`↔️ Line Spacing: ${isDouble ? 'Double (extra line between lines)' : 'Single (compact)'}`, `fmt_toggle_spacing:${gameName}`)],
        [Markup.button.callback('🌐 Apply this Game\'s Format to ALL Games', `fmt_apply_to_all:${gameName}`)],
        [Markup.button.callback('🔄 Reset to Global Format', `fmt_reset:${gameName}`)],
        [Markup.button.callback('🔗 Set Channel Post Link', `fmt_set_post_link:${gameName}`)],
        [Markup.button.callback('🚀 Test Send to Group', `fmt_test_send:${gameName}`)],
        [Markup.button.callback('🔙 Back to Games List', 'fmt_indiv_select')]
      ]);

      await ctx.reply(instructionText, { parse_mode: 'Markdown', ...keyboard });
    });

    // Set Telegram Channel Post Link
    bot.action(/^fmt_set_post_link:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      userSessions[ctx.from.id] = { step: 'awaiting_game_post_link', game: gameName };
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply(`🔗 *Set Telegram Post Link for ${gameName}*\n\nPlease send the t.me link for the specific channel post you want to automatically edit for this game (e.g. \`https://t.me/mychannel/123\`).\n\nSend \`clear\` to remove the link.`, { parse_mode: 'Markdown' });
    });

    // Toggle spacing for individual game
    bot.action(/^fmt_toggle_spacing:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      const current = getEffectiveGameFormat(gameName);
      const nextSpacing = current.lineSpacing === 'single' ? 'double' : 'single';
      updateGameFormat(gameName, { lineSpacing: nextSpacing });
      await ctx.answerCbQuery(nextSpacing === 'double' ? 'Extra line between lines added!' : 'Single line spacing set!').catch(() => {});

      const updatedFormat = getEffectiveGameFormat(gameName);
      const sampleItems = getGameItemsSample(gameName);
      const preview = formatGameMessage(gameName, sampleItems, updatedFormat);

      const isDouble = nextSpacing === 'double';
      await ctx.reply(
        `↔️ *Spacing for ${gameName} set to ${isDouble ? 'Double (extra line between every 2 lines)' : 'Single (compact lines)'}!*\n\nPreview:\n\`\`\`\n${preview}\n\`\`\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`↔️ Line Spacing: ${isDouble ? 'Make Single' : 'Add Extra Line Between Lines'}`, `fmt_toggle_spacing:${gameName}`)],
            [Markup.button.callback('🌐 Apply this format to ALL Games', `fmt_apply_to_all:${gameName}`)],
            [Markup.button.callback('🔙 Back to Game Editor', `fmt_game:${gameName}`)]
          ])
        }
      );
    });

    // Apply this game's format to all games
    bot.action(/^fmt_apply_to_all:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      applyGameFormatToAll(gameName);
      await ctx.answerCbQuery('Applied to all games!').catch(() => {});
      
      const formats = getFormats();
      await ctx.reply(
        `🌐 *Applied to ALL Games!*\n\nThe header template, line spacing, and footer from *${gameName}* are now the global standard for all games:\n\n` +
        `• *Global Header*: \`${formats.global.header}\`\n` +
        `• *Global Spacing*: \`${formats.global.lineSpacing}\`\n` +
        `• *Global Footer*: \`${formats.global.footer || '(none)'}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('👀 Preview Sample Message', 'fmt_preview_sample')],
            [Markup.button.callback('🔙 Format Settings', 'menu_format')]
          ])
        }
      );
    });

    // Reset game format to global
    bot.action(/^fmt_reset:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      resetGameFormat(gameName);
      await ctx.answerCbQuery('Reset to global format').catch(() => {});
      await ctx.reply(
        `🔄 *${gameName}* has been reset to inherit the Global Format.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🎮 Back to Games List', 'fmt_indiv_select')],
            [Markup.button.callback('🔙 Format Settings', 'menu_format')]
          ])
        }
      );
    });

    // Test send a specific game to the group
    bot.action(/^fmt_test_send:(.+)$/, async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      const gameName = ctx.match[1];
      const groupId = process.env.TELEGRAM_GROUP_ID;
      if (!groupId) {
        await ctx.reply('⚠️ TELEGRAM_GROUP_ID is not configured.');
        return;
      }
      const sampleItems = getGameItemsSample(gameName);
      const textToSend = formatGameMessage(gameName, sampleItems);
      try {
        await sendTelegramMessage(groupId, textToSend);
        await ctx.answerCbQuery('Sent to group!').catch(() => {});
        await ctx.reply(`🚀 Test message for *${gameName}* was sent to the Telegram group!`, { parse_mode: 'Markdown' });
      } catch (e: any) {
        await ctx.reply(`❌ Failed to send to group: ${e.message}`);
      }
    });

    // Preview sample message
    bot.action('fmt_preview_sample', async (ctx) => {
      if (!isUserAdmin(ctx.from.id, ctx.from.username)) return;
      await ctx.answerCbQuery().catch(() => {});
      const sampleGame = 'Mobile Legends: Bang Bang';
      const sampleItems = getGameItemsSample(sampleGame);
      const preview = formatGameMessage(sampleGame, sampleItems);

      await ctx.reply(`👀 *Live Message Preview (${sampleGame}):*`, { parse_mode: 'Markdown' });
      await ctx.reply(preview, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Format Menu', 'menu_format')]
        ])
      }).catch(err => {
         // Fallback if HTML parsing fails due to unclosed tags etc
         ctx.reply(preview, {
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back to Format Menu', 'menu_format')]
          ])
        });
      });
    });

    bot.action('noop', async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
    });

    // Handle incoming text messages for editing sessions
    bot.on('text', async (ctx) => {
      const userId = ctx.from.id;
      const session = userSessions[userId];
      const text = ctx.message.text.trim();

      if (text.startsWith('/')) {
        delete userSessions[userId];
        return;
      }

      // Check admin permissions
      if (!isUserAdmin(userId, ctx.from.username)) {
        return;
      }

      if (session) {
        if (session.step === 'awaiting_game_format') {
          const gameName = session.game;
          const parsed = parseModifiedPricelist(text, gameName);
          updateGameFormat(gameName, parsed);
          delete userSessions[userId];

          addLog(`Admin @${ctx.from.username || userId} updated format for ${gameName}`, 'info');

          const previewItems = getGameItemsSample(gameName);
          const renderedPreview = formatGameMessage(gameName, previewItems, parsed);

          await ctx.reply(
            `✅ *Format successfully saved for ${gameName}!*\n\n` +
            `• *Header*:\n\`${parsed.header || '(none)'}\`\n\n` +
            `• *Line Spacing*: ${parsed.lineSpacing === 'double' ? '`Double (extra line between every 2 lines)`' : '`Preserved custom extra lines & groups`'}\n\n` +
            `• *Footer*:\n\`${parsed.footer || '(none)'}\`\n\n` +
            `Here is how your future updates will look in Telegram:\n👇👇👇`,
            { parse_mode: 'Markdown' }
          );

          await ctx.reply(renderedPreview);

          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🌐 Apply This Format to ALL Games', `fmt_apply_to_all:${gameName}`)],
            [Markup.button.callback('🚀 Test Send to Group', `fmt_test_send:${gameName}`)],
            [Markup.button.callback('✏️ Edit Again', `fmt_game:${gameName}`)],
            [Markup.button.callback('🔙 Format Settings', 'menu_format')]
          ]);

          await ctx.reply('Choose next action:', keyboard);
          return;
        }

        if (session.step === 'awaiting_global_format') {
          const parsed = parseModifiedPricelist(text, '{game}');
          // If the header mentions a specific game name, replace it with {game}
          let header = parsed.header;
          header = header.replace(/Mobile Legends(?:: Bang Bang)?/gi, '{game}')
                         .replace(/Delta Force/gi, '{game}')
                         .replace(/PUBG/gi, '{game}')
                         .replace(/Honor of Kings/gi, '{game}');

          updateGlobalFormat({
            header,
            footer: parsed.footer,
            lineSpacing: parsed.lineSpacing,
            itemPrefix: parsed.itemPrefix,
            customTemplate: parsed.customTemplate
          });
          delete userSessions[userId];

          addLog(`Admin @${ctx.from.username || userId} updated Global Format via sample edit`, 'info');

          const sampleItems = getGameItemsSample('Mobile Legends: Bang Bang');
          const renderedPreview = formatGameMessage('Mobile Legends: Bang Bang', sampleItems, getFormats().global);

          await ctx.reply(
            `✅ *Global Format Updated for ALL Games!*\n\n` +
            `• *Header Template*:\n\`${header}\`\n\n` +
            `• *Line Spacing*: ${parsed.lineSpacing === 'double' ? '`Double (extra line between every 2 lines)`' : '`Preserved custom extra lines & groups`'}\n\n` +
            `• *Footer*:\n\`${parsed.footer || '(none)'}\`\n\n` +
            `Sample output for Mobile Legends:\n👇👇👇`,
            { parse_mode: 'Markdown' }
          );

          await ctx.reply(renderedPreview);

          await ctx.reply(
            'Global format active!',
            Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Back to Format Menu', 'menu_format')],
              [Markup.button.callback('🛠 Main Menu', 'menu_main')]
            ])
          );
          return;
        }

        if (session.step === 'awaiting_global_header') {
          updateGlobalFormat({ header: text });
          delete userSessions[userId];
          await ctx.reply(`✅ Global header updated to:\n\`${text}\``, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Global Format Menu', 'fmt_global')]])
          });
          return;
        }

        if (session.step === 'awaiting_game_post_link') {
          const gameName = session.game;
          const linkVal = text.toLowerCase() === 'clear' ? '' : text;
          
          import('./db.js').then(({ updateGamePostLink }) => {
            updateGamePostLink(gameName, linkVal);
          });
          
          delete userSessions[userId];
          
          if (linkVal) {
             const parsed = parseTelegramPostLink(linkVal);
             if (parsed) {
                 await ctx.reply(`✅ Telegram post link saved for ${gameName}. Bot will attempt to edit chat \`${parsed.chatId}\` message \`${parsed.messageId}\` on next update.`, { parse_mode: 'Markdown' });
             } else {
                 await ctx.reply(`⚠️ Link saved, but it doesn't look like a standard \`t.me\` post link. Make sure it's correct.`, { parse_mode: 'Markdown' });
             }
          } else {
             await ctx.reply(`✅ Telegram post link cleared for ${gameName}.`, { parse_mode: 'Markdown' });
          }
          return;
        }

        if (session.step === 'awaiting_global_footer') {
          const footerVal = text.toLowerCase() === 'clear' ? '' : text;
          updateGlobalFormat({ footer: footerVal });
          delete userSessions[userId];
          await ctx.reply(`✅ Global footer updated to:\n\`${footerVal || '(none)'}\``, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Global Format Menu', 'fmt_global')]])
          });
          return;
        }
      } else {
        // Auto-detect if an admin simply pasted a modified price list without being in a session
        for (const gName of Object.keys(GAME_URLS)) {
          const lowerText = text.toLowerCase();
          const lowerGame = gName.toLowerCase();
          const isMl = lowerGame.includes('mobile legends') && lowerText.includes('mobile legends');
          if (lowerText.includes(lowerGame) || isMl) {
            const parsed = parseModifiedPricelist(text, gName);
            updateGameFormat(gName, parsed);
            addLog(`Admin @${ctx.from.username || userId} auto-updated format for ${gName}`, 'info');

            const previewItems = getGameItemsSample(gName);
            const renderedPreview = formatGameMessage(gName, previewItems, parsed);

            await ctx.reply(
              `✅ *Format automatically saved for ${gName}!*\n\n` +
              `• *Header*:\n\`${parsed.header || '(none)'}\`\n\n` +
              `• *Line Spacing*: ${parsed.lineSpacing === 'double' ? '`Double (extra line between every 2 lines)`' : '`Preserved custom extra lines & groups`'}\n\n` +
              `• *Footer*:\n\`${parsed.footer || '(none)'}\`\n\n` +
              `Here is how your future updates will look in Telegram:\n👇👇👇`,
              { parse_mode: 'Markdown' }
            );

            await ctx.reply(renderedPreview);

            const keyboard = Markup.inlineKeyboard([
              [Markup.button.callback('🌐 Apply This Format to ALL Games', `fmt_apply_to_all:${gName}`)],
              [Markup.button.callback('🚀 Test Send to Group', `fmt_test_send:${gName}`)],
              [Markup.button.callback('✏️ Edit Again', `fmt_game:${gName}`)],
              [Markup.button.callback('🔙 Format Settings', 'menu_format')]
            ]);

            await ctx.reply('Choose next action:', keyboard);
            return;
          }
        }
      }
    });

    bot.catch((err: any) => {
      console.error('Telegraf error:', err);
      addLog(`Telegram bot error: ${err.message}`, 'error');
    });

    bot.launch();

    addLog('Telegram bot initialized successfully.', 'info');

    // Schedule automated scraping every hour
    cron.schedule('0 * * * *', async () => {
      addLog('Starting scheduled scrape...', 'info');
      await scrapePrices(false);
    });

  } catch (error: any) {
    console.error('Error initializing Telegram bot:', error);
    addLog(`Error initializing bot: ${error.message}`, 'error');
  }
}

async function sendAdminMainMenu(ctx: any) {
  const catalog = getSupplierCatalog();
  const newGames = catalog.newDetectedGames || {};
  const newCount = Object.keys(newGames).length;

  let text = `🤖 *Game Pricelist Bot - Admin Panel*\n\nWelcome! Manage your pricelist formats, trigger instant scrapes, and review bot settings below:`;
  if (newCount > 0) {
    text += `\n\n🔔 *Supplier Notice:* *${newCount}* new game(s) detected from supplier! Tap below to add or review.`;
  }

  const buttons: any[] = [];
  if (newCount > 0) {
    buttons.push([Markup.button.callback(`🔔 ${newCount} New Game(s) from Supplier!`, 'menu_new_games')]);
  }
  buttons.push([Markup.button.callback('🔍 Check Supplier Catalog Now', 'menu_check_supplier')]);
  buttons.push([Markup.button.callback('🎨 Format Settings (Headers & Spacing)', 'menu_format')]);
  buttons.push([Markup.button.callback('⚡ Scrape & Send Updates Only', 'menu_scrape_updates')]);
  buttons.push([Markup.button.callback('📢 Scrape & Send All Games', 'menu_scrape_all')]);
  buttons.push([Markup.button.callback('📋 View Live Game Prices', 'menu_prices')]);
  buttons.push([Markup.button.callback('👥 Admin Accounts', 'menu_admins')]);

  const keyboard = Markup.inlineKeyboard(buttons);
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

async function sendFormatMenu(ctx: any) {
  const formats = getFormats();
  const customGameCount = Object.keys(formats.games).length;
  const text = `🎨 *Pricelist Format Settings*\n\nConfigure headers, footers, and spacing between lines:\n\n• *Global Default*:\n  Header: \`${formats.global.header}\`\n  Spacing: \`${formats.global.lineSpacing}\`\n  Footer: \`${formats.global.footer ? formats.global.footer.replace(/\n/g, ' ') : '(none)'}\`\n\n• *Individual Game Overrides*: ${customGameCount} customized game(s).\n\nChoose an option:`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🌐 All Games (Global Format)', 'fmt_global')],
    [Markup.button.callback('🎮 Individual Game Option', 'fmt_indiv_select')],
    [Markup.button.callback('👀 Preview Sample Message', 'fmt_preview_sample')],
    [Markup.button.callback('🔙 Back to Main Menu', 'menu_main')]
  ]);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

async function sendGlobalFormatMenu(ctx: any) {
  const formats = getFormats();
  const isDouble = formats.global.lineSpacing === 'double';
  const text = `🌐 *Global Format (All Games)*\n\nThis format is applied to all games that do not have custom overrides:\n\n• *Header Template*:\n\`${formats.global.header}\`\n*(Tip: \`{game}\` is automatically replaced with the game name)*\n\n• *Line Spacing*: \`${formats.global.lineSpacing}\` (${isDouble ? 'double spacing between lines' : 'single line spacing'})\n\n• *Footer Template*:\n\`${formats.global.footer || '(none)'}\`\n\nChoose an action:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`↔️ Toggle Spacing: ${isDouble ? 'Double' : 'Single'}`, 'fmt_global_toggle_spacing')],
    [Markup.button.callback('📝 Send Modified Sample', 'fmt_global_sample')],
    [Markup.button.callback('✏️ Set Header Text', 'fmt_global_set_header')],
    [Markup.button.callback('✏️ Set Footer Text', 'fmt_global_set_footer')],
    [Markup.button.callback('🔄 Reset to Default', 'fmt_global_reset')],
    [Markup.button.callback('🔙 Back to Format Menu', 'menu_format')]
  ]);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

async function sendIndividualGamesSelect(ctx: any, page: number = 0) {
  const margins = getMargins();
  let games = Object.keys(margins);
  if (games.length === 0) {
    games = Object.keys(GAME_URLS).slice(0, 10);
  }
  const formats = getFormats();
  const PAGE_SIZE = 6;
  const totalPages = Math.ceil(games.length / PAGE_SIZE) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const pageGames = games.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const buttons = pageGames.map(g => {
    const isCustom = !!formats.games[g];
    return [Markup.button.callback(`${isCustom ? '⭐ ' : ''}${g}`, `fmt_game:${g}`)];
  });

  const navRow = [];
  if (currentPage > 0) {
    navRow.push(Markup.button.callback('⬅️ Prev', `fmt_page:${currentPage - 1}`));
  }
  navRow.push(Markup.button.callback(`📄 ${currentPage + 1}/${totalPages}`, 'noop'));
  if (currentPage < totalPages - 1) {
    navRow.push(Markup.button.callback('Next ➡️', `fmt_page:${currentPage + 1}`));
  }
  buttons.push(navRow);
  buttons.push([Markup.button.callback('🔙 Back to Format Menu', 'menu_format')]);

  const text = `🎮 *Individual Game Option*\n\nTap any game name below:\nThe bot will send its current pricelist repo, and you can send back your modified version with custom header, footer, spacing, or emojis:`;
  const keyboard = Markup.inlineKeyboard(buttons);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

async function sendTelegramMessage(chatId: string, text: string) {
    if (!bot) return;
    const sendChunk = async (chunkText: string) => {
        try {
            await bot!.telegram.sendMessage(chatId, chunkText, { parse_mode: 'HTML' });
        } catch (err: any) {
            await bot!.telegram.sendMessage(chatId, chunkText);
        }
    };

    if (text.length <= 4000) {
        await sendChunk(text);
        return;
    }

    const lines = text.split('\n');
    let chunk = '';
    for (const line of lines) {
        if ((chunk + '\n' + line).length > 4000) {
            await sendChunk(chunk.trim());
            await new Promise(r => setTimeout(r, 400));
            chunk = line;
        } else {
            chunk += (chunk ? '\n' : '') + line;
        }
    }
    if (chunk.trim()) {
        await sendChunk(chunk.trim());
    }
}

export async function notifyAdmins(text: string, keyboard?: any) {
    if (!bot) return;
    const admins = getAdmins();
    for (const admin of admins) {
        if (/^-?\d+$/.test(admin)) {
            try {
                if (keyboard) {
                    await bot.telegram.sendMessage(admin, text, { parse_mode: 'HTML', ...keyboard });
                } else {
                    await bot.telegram.sendMessage(admin, text, { parse_mode: 'HTML' });
                }
            } catch (e) {
                // Ignore if admin has not started conversation with bot yet
            }
        }
    }
}

export async function syncSupplierCatalog(browserContext?: any): Promise<{
    deletedGames: string[];
    newGames: { name: string; url: string }[];
    totalLive: number;
}> {
    let createdBrowser = false;
    let context = browserContext;
    let browser: any = null;

    if (!context) {
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext();
        createdBrowser = true;
    }

    const deletedGames: string[] = [];
    const newGames: { name: string; url: string }[] = [];
    let totalLive = 0;

    try {
        const page = await context.newPage();
        await page.route('**/*', (route: any) => {
            const type = route.request().resourceType();
            if (['image', 'font', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        addLog('Scanning supplier catalog at https://2gethermart.com...', 'info');
        await page.goto('https://2gethermart.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

        const liveGames: Record<string, string> = await page.evaluate(() => {
            const map: Record<string, string> = {};
            const links = Array.from(document.querySelectorAll('a[href*="/game/"]'));
            for (const a of links) {
                const href = (a as HTMLAnchorElement).href;
                let name = a.querySelector('h2, h3, h4, .title, [class*="title"], [class*="name"], p, span')?.textContent?.trim() || a.textContent?.trim() || '';
                name = name.replace(/\n+/g, ' ').replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
                if (name && href && !map[name]) {
                    map[name] = href;
                }
            }
            return map;
        });

        await page.close();

        const liveGameNames = Object.keys(liveGames);
        totalLive = liveGameNames.length;
        addLog(`Supplier catalog scanned: ${totalLive} games found online.`, 'info');

        if (totalLive === 0) {
            addLog('Supplier catalog returned 0 games. Skipping sync to prevent false removals.', 'error');
            return { deletedGames: [], newGames: [], totalLive: 0 };
        }

        const catalog = getSupplierCatalog();
        const margins = getMargins();

        // Build slug and normalized name lookups for live games
        const liveSlugs = new Set<string>();
        const liveNamesNorm = new Set<string>();
        for (const [name, url] of Object.entries(liveGames)) {
            const slug = url.split('/game/')[1]?.replace(/\/$/, '').toLowerCase();
            if (slug) liveSlugs.add(slug);
            liveNamesNorm.add(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
        }

        // 1. AUTOMATIC REMOVAL OF DISCONTINUED / DELETED GAMES
        // If supplier changed their game list and removed games, remove them from database and everywhere
        const trackedGames = new Set<string>([
            ...Object.keys(catalog.games || {}),
            ...Object.keys(margins)
        ]);

        for (const gameName of trackedGames) {
            const currentUrl = catalog.games[gameName] || GAME_URLS[gameName] || '';
            const slug = currentUrl.split('/game/')[1]?.replace(/\/$/, '').toLowerCase();
            const norm = gameName.toLowerCase().replace(/[^a-z0-9]/g, '');

            const stillExists = (slug && liveSlugs.has(slug)) || 
                                liveNamesNorm.has(norm) ||
                                liveGames[gameName] !== undefined;

            if (!stillExists) {
                addLog(`Supplier discontinued game "${gameName}". Removing from database and everywhere.`, 'alert');
                removeGameEverywhere(gameName);
                delete GAME_URLS[gameName];
                delete lastPrices[gameName];
                deletedGames.push(gameName);

                const alertHtml = `🗑️ <b>Supplier Discontinued Game Notice:</b>\n\n` +
                    `<b>${gameName}</b> is no longer listed on the supplier website.\n\n` +
                    `✅ <b>Action taken:</b> Removed from database margins, price history, and format configs everywhere.`;

                if (bot && process.env.TELEGRAM_GROUP_ID) {
                    await sendTelegramMessage(process.env.TELEGRAM_GROUP_ID, alertHtml);
                }
                await notifyAdmins(alertHtml);
            }
        }

        // 2. DETECT NEW GAMES & NOTIFY / REMIND ADMIN
        // If there's something new, trigger notification and remind admin to add new game from website, and bot should know that itself.
        for (const [liveName, liveUrl] of Object.entries(liveGames)) {
            const slug = liveUrl.split('/game/')[1]?.replace(/\/$/, '').toLowerCase();
            const norm = liveName.toLowerCase().replace(/[^a-z0-9]/g, '');

            let isKnown = false;
            for (const knownName of Object.keys(catalog.games || {})) {
                const knownSlug = catalog.games[knownName]?.split('/game/')[1]?.replace(/\/$/, '').toLowerCase();
                const knownNorm = knownName.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (knownSlug === slug || knownNorm === norm || knownName === liveName) {
                    isKnown = true;
                    break;
                }
            }

            if (!isKnown && !margins[liveName]) {
                // New game detected!
                addNewDetectedGame(liveName, liveUrl);
                GAME_URLS[liveName] = liveUrl;
                newGames.push({ name: liveName, url: liveUrl });

                addLog(`New game detected on supplier website: "${liveName}". Reminding admin to add it.`, 'alert');

                const reminderHtml = `🔔 <b>New Game Detected on Supplier Website!</b>\n\n` +
                    `The supplier has added a new game to their catalog:\n` +
                    `🎮 <b>${liveName}</b>\n` +
                    `🔗 <a href="${liveUrl}">${liveUrl}</a>\n\n` +
                    `⚠️ <b>Admin Reminder:</b> Please visit the website dashboard to add this game and configure its profit margin, or tap Quick Add below!`;

                if (bot && process.env.TELEGRAM_GROUP_ID) {
                    await sendTelegramMessage(process.env.TELEGRAM_GROUP_ID, reminderHtml);
                }
                await notifyAdmins(reminderHtml, Markup.inlineKeyboard([
                    [Markup.button.callback(`➕ Quick Add (10% Margin)`, `quick_add_game:${liveName}`)],
                    [Markup.button.callback('📋 View All New Games', 'menu_new_games')]
                ]));
            } else {
                if (!catalog.games) catalog.games = {};
                catalog.games[liveName] = liveUrl;
                GAME_URLS[liveName] = liveUrl;
            }
        }

        catalog.lastSync = new Date().toISOString();
        saveSupplierCatalog(catalog);

    } catch (err: any) {
        addLog(`Supplier catalog sync error: ${err.message}`, 'error');
    } finally {
        if (createdBrowser && browser) {
            await browser.close();
        }
    }

    return { deletedGames, newGames, totalLive };
}

export async function triggerManualScrape(forceSend: boolean = true, targetGame?: string) {
    try {
        await scrapePrices(forceSend, targetGame);
    } catch (e: any) {
        addLog(`Manual scrape failed: ${e.message}`, 'error');
        throw e;
    }
}

const initialCatalog = getSupplierCatalog();
export const GAME_URLS: Record<string, string> = {
    ...initialCatalog.games,
    "Mobile Legends: Bang Bang": "https://2gethermart.com/game/mobile-legends",
    "Mobile Legends - MY": "https://2gethermart.com/game/mobile-legends-my",
    "Mobile Legends - SG": "https://2gethermart.com/game/mobile-legends-sg",
    "Mobile Legends - ID": "https://2gethermart.com/game/mobile-legends-id",
    "Mobile Legends - Russia": "https://2gethermart.com/game/mobile-legends-russia",
    "Mobile Legends: Adventure": "https://2gethermart.com/game/mobile-legends-adventure",
    "MLBB Turkey": "https://2gethermart.com/game/mlbb-turkey-",
    "PUBG MOBILE": "https://2gethermart.com/game/pubg-mobile-",
    "Honor of Kings": "https://2gethermart.com/game/honor-of-kings-",
    "Delta Force - Steam": "https://2gethermart.com/game/delta-force-steam",
    "Delta Force - Garena": "https://2gethermart.com/game/delta-force-garena",
    "Delta Force (Provider 2)": "https://2gethermart.com/game/delta-force-provider-2-",
    "Where Winds Meet (Provider 2)": "https://2gethermart.com/game/where-winds-meet-provider2",
    "Sword of Justice (Provider 1)": "https://2gethermart.com/game/sword-of-justice-provider-1-",
    "Sword of Justice (Provider 2)": "https://2gethermart.com/game/sword-of-justice-",
    "Magic Chess: Go Go": "https://2gethermart.com/game/magic-chess-go-go",
    "Blood Strike": "https://2gethermart.com/game/blood-strike",
    "Blood Strike Packs": "https://2gethermart.com/game/blood-strike-packs",
    "Heartopia (Provider 3)": "https://2gethermart.com/game/heartopia-provider-3",
    "Arena Breakout (Provider 2)": "https://2gethermart.com/game/arena-breakout-provider-2-",
    "Arena Breakout (Provider 3)": "https://2gethermart.com/game/arena-breakout-provider-3-",
    "Blockman Go": "https://2gethermart.com/game/blockman-go",
    "Sausage Man": "https://2gethermart.com/game/sausage-man",
    "Honkai: Star Rail": "https://2gethermart.com/game/honkai-star-rail-provider-2",
    "Wuthering Waves (Provider 1)": "https://2gethermart.com/game/wuthering-waves-provider-1",
    "Wuthering Waves (Provider 2)": "https://2gethermart.com/game/wuthering-waves2-",
    "Honkai Impact 3": "https://2gethermart.com/game/honkai-impact-3",
    "Zenless Zone Zero (Provider 2)": "https://2gethermart.com/game/zenless-zone-zero-p2",
    "Stumble Guys": "https://2gethermart.com/game/stumble-guys-",
    "Bigo Live Diamonds": "https://2gethermart.com/game/bigo-live-diamonds",
    "Love and Deepspace": "https://2gethermart.com/game/love-and-deepspace",
    "Life After": "https://2gethermart.com/game/life-after",
    "Identity V": "https://2gethermart.com/game/identity-v",
    "ZEPETO": "https://2gethermart.com/game/zepeto",
    "Devil May Cry: Peak of Combat": "https://2gethermart.com/game/devil-may-cry-peak-of-combat",
    "Growtopia": "https://2gethermart.com/game/growtopia",
    "Farlight 84": "https://2gethermart.com/game/farlight-84",
    "Poppo Live": "https://2gethermart.com/game/poppo-live",
    "Sky Children of the Light": "https://2gethermart.com/game/sky-children-of-the-light-",
    "Telegram Star & Telegram Premium": "https://2gethermart.com/game/telegram-star-telegram-premium-",
    "Freefire Brazil": "https://2gethermart.com/game/free-fire-brazil-server-",
    "Freefire Vietnam": "https://2gethermart.com/game/freefire-vietnam-p2-",
    "Freefire (SG/Malay)": "https://2gethermart.com/game/free-fire-sg-malay-",
    "Freefire Global": "https://2gethermart.com/game/freefire-global",
    "Freefire Europe": "https://2gethermart.com/game/freefire-europe-",
    "Freefire Taiwan": "https://2gethermart.com/game/freefire-taiwan-",
    "Freefire Indonesia": "https://2gethermart.com/game/freefire-indonesia-",
    "Freefire Middle East": "https://2gethermart.com/game/freefire-middle-east-",
    "Freefire Singapore": "https://2gethermart.com/game/freefire-singapore-",
    "Freefire Bangladesh": "https://2gethermart.com/game/freefire-bangladesh-",
    "Freefire LATAM": "https://2gethermart.com/game/freefire-latam-",
    "Neverness to Everness": "https://2gethermart.com/game/neverness-to-everness",
    "Call of Duty": "https://2gethermart.com/game/call-of-duty",
    "Once Human": "https://2gethermart.com/game/once-human",
    "Genshin Impact": "https://2gethermart.com/game/genshin-impact-",
    "Super Sus": "https://2gethermart.com/game/super-sus",
    "Age of Empires Mobile": "https://2gethermart.com/game/age-of-empires-mobile",
    "Racing Master SEA": "https://2gethermart.com/game/racing-master-",
    "Racing Master LATAM": "https://2gethermart.com/game/racing-master-latam"
};

export function parseTelegramPostLink(link: string): { chatId: string, messageId: number } | null {
    try {
        const url = new URL(link);
        if (url.hostname !== 't.me') return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length === 3 && parts[0] === 'c') {
            const chatId = '-100' + parts[1];
            const messageId = parseInt(parts[2], 10);
            return { chatId, messageId };
        }
        if (parts.length === 2) {
            const chatId = '@' + parts[0];
            const messageId = parseInt(parts[1], 10);
            return { chatId, messageId };
        }
    } catch {
        return null;
    }
    return null;
}

export async function scrapePrices(forceSend: boolean = false, targetGame?: string) {
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    // 1. Sync supplier catalog to detect discontinued or newly added games
    try {
      await syncSupplierCatalog(context);
    } catch (catErr: any) {
      addLog(`Supplier catalog sync warning: ${catErr.message}`, 'error');
    }

    // 2. Refresh margins in case any discontinued games were removed
    const margins = getMargins();
    let gamesToScrape = Object.keys(margins);
    
    if (targetGame && gamesToScrape.includes(targetGame)) {
      gamesToScrape = [targetGame];
    }
    
    if (gamesToScrape.length === 0) {
        addLog('No games configured in margins. Skipping scrape.', 'info');
        await browser.close();
        return;
    }

    const scrapedData: Record<string, Record<string, string>> = {};
    let hasChanges = false;
    let messageBody = '';
    const itemsToSave = getScrapedItems();

    for (const gameName of gamesToScrape) {
        const url = GAME_URLS[gameName] || `https://2gethermart.com/game/${gameName.toLowerCase().replace(/\s+/g, '-')}`;
        scrapedData[gameName] = {};
        const marginConfig = margins[gameName] || { defaultMargin: 0, items: {} };

        try {
            addLog(`Scraping ${gameName} at ${url}...`, 'info');
            const page = await context.newPage();
            
            // Abort unnecessary resources to speed up load and avoid blocks
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'font', 'media'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            await page.goto(url, { waitUntil: 'domcontentloaded' });

            // Wait for mmk/ks marker to appear, signifying prices loaded
            await page.waitForFunction(() => /(?:mmk|ks|ကျပ်)/iu.test(document.body?.innerText || ""), null, { timeout: 15000 }).catch(() => {
                addLog(`Timeout waiting for prices on ${gameName}`, 'info');
            });
            await page.waitForTimeout(500);

            const items = await page.evaluate(() => {
                const results: { name: string, price: string }[] = [];
                
                // Strategy 1: Package Buttons (common on 2gethermart for specific items)
                const buttons = document.querySelectorAll("button, [role='button']");
                buttons.forEach(btn => {
                    const lines = (btn.textContent || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                    const priceLineIndex = lines.findIndex(l => /(?:mmk|ks)\b/i.test(l));
                    if (priceLineIndex > 0) {
                        const name = lines[priceLineIndex - 1];
                        const price = lines[priceLineIndex];
                        results.push({ name, price });
                    }
                });

                // Strategy 2: Cards
                if (results.length === 0) {
                    const cards = document.querySelectorAll("[data-product], [data-product-id], .product, .product-card, .product-item, .card");
                    cards.forEach(card => {
                        const nameEl = card.querySelector("[data-name], .product-title, .product-name, .title, .name, h3, h4");
                        const priceEl = card.querySelector("[data-price], .price, .amount, .product-price");
                        if (nameEl && priceEl) {
                            results.push({ name: nameEl.textContent?.trim() || '', price: priceEl.textContent?.trim() || '' });
                        }
                    });
                }

                // Strategy 3: Text fallback
                if (results.length === 0) {
                     const lines = (document.body?.innerText || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                     for (let i = 0; i < lines.length; i++) {
                          const line = lines[i];
                          if (/(?:mmk|ks)\b/i.test(line) && i > 0) {
                              // assume previous line is name
                              results.push({ name: lines[i-1], price: line });
                          }
                     }
                }

                return results;
            });

            // Process and apply margins
            const uniqueItemsMap = new Map();
            itemsToSave[gameName] = []; // Clear old strings before pushing objects
            
            for (const item of items) {
                if (item.name && item.price && !item.name.toLowerCase().includes('login') && !item.name.toLowerCase().includes('account')) {
                    if (uniqueItemsMap.has(item.name)) continue;
                    uniqueItemsMap.set(item.name, true);

                    const priceMatch = item.price.match(/[\d,.]+/);
                    if (priceMatch) {
                        const originalPriceNum = parseFloat(priceMatch[0].replace(/,/g, ''));
                        const itemMargin = marginConfig.items[item.name] !== undefined ? marginConfig.items[item.name] : marginConfig.defaultMargin;
                        const finalPrice = Math.round((originalPriceNum * (1 + (itemMargin / 100))) / 50) * 50;
                        const profit = finalPrice - originalPriceNum;
                        scrapedData[gameName][item.name] = `${finalPrice} ks`;
                        
                        if (!itemsToSave[gameName]) itemsToSave[gameName] = [];
                        itemsToSave[gameName].push({
                            name: item.name,
                            originalPrice: originalPriceNum,
                            finalPrice,
                            profit
                        });
                    } else {
                        scrapedData[gameName][item.name] = item.price;
                        if (!itemsToSave[gameName]) itemsToSave[gameName] = [];
                        itemsToSave[gameName].push({
                            name: item.name,
                            originalPrice: 0,
                            finalPrice: 0,
                            profit: 0
                        });
                    }
                }
            }

            await page.close();
        } catch (e: any) {
            addLog(`Error scraping ${gameName}: ${e.message}`, 'error');
        }
    }
    
    saveScrapedItems(itemsToSave);
    await browser.close();

    // Compare with last prices and build individual game messages
    const gamesToSend: { game: string; text: string; hasChanges: boolean; postLink?: string }[] = [];
    let anyChanges = false;

    for (const game in scrapedData) {
        if (Object.keys(scrapedData[game]).length === 0) continue;

        let gameHasChanges = false;
        const itemsList: { cleanItem: string; priceNum: string }[] = [];
        
        for (const item in scrapedData[game]) {
            const currentPrice = scrapedData[game][item];
            const oldPrice = lastPrices[game]?.[item];
            if (oldPrice !== currentPrice) {
                gameHasChanges = true;
                anyChanges = true;
            }
            
            let cleanItem = item.replace(/(?:\s*(?:Diamonds|Gold|Lunites|Monochrome|Devil Gems|Heart Diamond|Heartopia Diamond|Coins|Supplies|UC|Unknown Cash|Diamond))$/i, '');
            // Apply shorter aliases for long package names to match visual style
            cleanItem = cleanItem.replace(/Weekly Pass/ig, 'WP')
                                 .replace(/Twilight Pass/ig, 'Twilight')
                                 .replace(/Monthly Epic Bundle/ig, 'Monthly')
                                 .replace(/Weekly Elite Bundle/ig, 'Weekly Elite');
            
            const priceNum = currentPrice.replace(/ ks$/i, '').trim();
            itemsList.push({ cleanItem, priceNum });
        }
        
        // Use custom / effective format for this game
        const gameText = formatGameMessage(game, itemsList);
        
        gamesToSend.push({
            game,
            text: gameText.trim(),
            hasChanges: gameHasChanges,
            postLink: margins[game]?.tgPostLink
        });
    }

    if (gamesToSend.length === 0) {
        addLog('No data could be extracted from the target website.', 'error');
        return;
    }

    if (bot) {
        let sentCount = 0;
        let editedCount = 0;
        for (const g of gamesToSend) {
            if (forceSend || g.hasChanges) {
                try {
                    let handled = false;
                    
                    // 1. Try to edit specific Telegram post if configured
                    if (g.postLink) {
                        const parsed = parseTelegramPostLink(g.postLink);
                        if (parsed) {
                            try {
                                await bot.telegram.editMessageText(parsed.chatId, parsed.messageId, undefined, g.text, { parse_mode: 'HTML' });
                                editedCount++;
                                handled = true;
                                await new Promise(r => setTimeout(r, 500));
                            } catch (editErr: any) {
                                addLog(`Failed to edit channel post for ${g.game}: ${editErr.message}`, 'error');
                            }
                        }
                    }
                    
                    // 2. Fallback / Default: Send to general group if no post link or edit failed, and GROUP ID exists
                    if (!handled && process.env.TELEGRAM_GROUP_ID) {
                        await sendTelegramMessage(process.env.TELEGRAM_GROUP_ID, g.text);
                        sentCount++;
                        await new Promise(r => setTimeout(r, 500));
                    }
                } catch (e: any) {
                    addLog(`Failed to process message for ${g.game}: ${e.message}`, 'error');
                }
            }
        }

        if (sentCount > 0 || editedCount > 0) {
            let msg = `Price updates: `;
            if (sentCount > 0) msg += `${sentCount} sent to group. `;
            if (editedCount > 0) msg += `${editedCount} edited in channels.`;
            addLog(msg.trim(), 'alert');
        } else if (!anyChanges) {
            addLog('Scrape completed. No price changes detected.', 'info');
        }
    }

    lastPrices = scrapedData;

  } catch (error: any) {
    console.error('Error during scraping:', error);
    addLog(`Scraping error: ${error.message}`, 'error');
  }
}
