# Player shops

[Wiki home](index.md)

Players can own one shop per character. The **Player shops** tab of the GM panel lists every shop on the server, opens one to show its stock, buy orders and recent sales, and offers two moderation actions. Nothing on this tab edits goods, prices or coins.

## What a shop is

A character pays a one-time 1,000 LiDollCoin license from the game menu (**My shop**), names the shop and its keeper, dresses the keeper in the Sprite Lab and picks an open hub tile. The keeper then stands in that hub as a fixture. Visitors who bump it see the shop's **FOR SALE** listings and **BUY ORDERS** inside the ordinary inventory window; the owner manages **STORED**, **FOR SALE**, **ORDERS** and a **LEDGER** of the last 20 sales from the same window.

Limits are fixed on the server: 512 storage rows, 40 listings, 20 buy orders, prices from 1 to 1,000,000 coins. Sales pay the owner's wallet through the durable receipt system, so coins earned while the owner is away arrive in installments on later visits. Buy orders hold their escrow until filled or cancelled.

## The tab

**Search** matches the shop name, keeper name, owner account, owner character name or hub zone. Each row shows open/CLOSED, names, owner, zone and tile, and counts of listings, orders and stored units. **Open** shows:

- a summary line with the caps (listings/40, orders/20, coins held in escrow, stored units, opening date);
- **Stock**: every stored or listed row with its quantity, price and any units still settling;
- **Buy orders**: what the shop wants, at what price, and the coins held for it;
- **Recent sales**: the owner's ledger, newest first, with the buyer or seller name.

## Moderation actions

Both actions ask for a **Reason**, which goes into the audit log with the action.

- **Rename** replaces the shop name (48 characters) and/or the keeper name (32). Leave a field blank to keep it. Angle brackets and control characters are stripped on the server.
- **Force close** hides the storefront from every hub. The owner keeps the license, stock, listings and escrow and can reopen from **My shop**; if they do and the problem persists, close it again and raise it in Moderation. **Reopen storefront** restores a shop you closed.

A closed shop's fixture disappears on the next hub snapshot, so visitors standing beside it lose the window with the usual "the shopkeeper has left" notice.

## Where things live

Server: `player-stores.mjs` (`gm.list / detail / rename / setActive`), routes in `gm.mjs` (`/gm/player-stores`, actions `store_rename`, `store_set_active`). Client: `scrPlayerStores` inside the inventory modal (`scrOnlineInventory`). Tests: `node --test test/player-stores.test.mjs`.
