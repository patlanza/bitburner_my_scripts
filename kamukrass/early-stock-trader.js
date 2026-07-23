// file: stock-trader.js

// Requires TIX API Access + 4S Market Data TIX API Access.

// Shorting is normally only available in BitNode 8. Keep it disabled unless
// you know that the current run allows short positions.
const shortAvailable = false;

export async function main(ns) {
    ns.disableLog("ALL");
    if (!checkMarketAccess(ns)) return;
    const commission = ns.stock.getConstants().StockMarketCommission;

    while (true) {
        tendStocks(ns, commission);
        await ns.stock.nextUpdate();
    }
}

function checkMarketAccess(ns) {
    const constants = ns.stock.getConstants();
    if (!ns.stock.hasTixApiAccess()) {
        ns.tprint(
            `ERROR: falta TIX API Access. Coste: ` +
            `$${ns.format.number(constants.TixApiCost, 2)}.`,
        );
        ns.tprint("Cómpralo desde la bolsa y vuelve a ejecutar el script.");
        return false;
    }
    if (!ns.stock.has4SDataTixApi()) {
        ns.tprint(
            `ERROR: falta 4S Market Data TIX API Access. Coste: ` +
            `$${ns.format.number(constants.MarketDataTixApi4SCost, 2)}.`,
        );
        ns.tprint("Este script necesita 4S para consultar forecast y volatilidad.");
        return false;
    }
    return true;
}

function tendStocks(ns, commission) {
    ns.print("");
    const stocks = getAllStocks(ns, commission);

    stocks.sort((a, b) => b.profitPotential - a.profitPotential);

    var longStocks = new Set();
    var shortStocks = new Set();
    var overallValue = 0;

    for (const stock of stocks) {
        if (stock.longShares > 0) {
            if (stock.forecast > 0.5) {
                longStocks.add(stock.sym);
                ns.print(
                    `INFO ${stock.summary} LONG ${formatMoney(ns, stock.cost + stock.profit)} ` +
                    `${ns.format.percent(stock.cost > 0 ? stock.profit / stock.cost : 0, 2)}`,
                );
                overallValue += (stock.cost + stock.profit);
            }
            else {
                const salePrice = ns.stock.sellStock(stock.sym, stock.longShares);
                const saleTotal = salePrice * stock.longShares;
                const saleCost = stock.longPrice * stock.longShares;
                const saleProfit = saleTotal - saleCost - 2 * commission;
                stock.shares = 0;
                shortStocks.add(stock.sym);
                ns.print(`WARN ${stock.summary} SOLD for ${formatMoney(ns, saleProfit)} profit`);
            }
        }
        if (stock.shortShares > 0) {
            if (stock.forecast < 0.5) {
                shortStocks.add(stock.sym);
                ns.print(
                    `INFO ${stock.summary} SHORT ${formatMoney(ns, stock.cost + stock.profit)} ` +
                    `${ns.format.percent(stock.cost > 0 ? stock.profit / stock.cost : 0, 2)}`,
                );
                overallValue += (stock.cost + stock.profit);
            }
            else {
                const salePrice = ns.stock.sellShort(stock.sym, stock.shortShares);
                const saleTotal = salePrice * stock.shortShares;
                const saleCost = stock.shortPrice * stock.shortShares;
                const saleProfit = saleTotal - saleCost - 2 * commission;
                stock.shares = 0;
                longStocks.add(stock.sym);
                ns.print(`WARN ${stock.summary} SHORT SOLD for ${formatMoney(ns, saleProfit)} profit`);
            }
        }
    }

    for (const stock of stocks) {
        const cash = ns.getServerMoneyAvailable("home");
        //ns.print(`INFO ${stock.summary}`);
        if (stock.forecast > 0.55) {
            longStocks.add(stock.sym);
            //ns.print(`INFO ${stock.summary}`);
            if (cash > 500 * commission) {
                const sharesToBuy = Math.min(stock.maxShares, Math.floor((cash - commission) / stock.askPrice));
                const availableShares = Math.max(
                    0,
                    stock.maxShares - stock.longShares - stock.shortShares,
                );
                const safeShares = Math.min(availableShares, sharesToBuy);
                if (safeShares > 0 && ns.stock.buyStock(stock.sym, safeShares) > 0) {
                    ns.print(`WARN ${stock.summary} LONG BOUGHT ${ns.format.number(safeShares, 0)} shares`);
                }
            }
        }
        else if (stock.forecast < 0.45 && shortAvailable) {
            shortStocks.add(stock.sym);
            //ns.print(`INFO ${stock.summary}`);
            if (cash > 500 * commission) {
                const sharesToBuy = Math.min(stock.maxShares, Math.floor((cash - commission) / stock.bidPrice));
                const availableShares = Math.max(
                    0,
                    stock.maxShares - stock.longShares - stock.shortShares,
                );
                const safeShares = Math.min(availableShares, sharesToBuy);
                if (safeShares > 0 && ns.stock.buyShort(stock.sym, safeShares) > 0) {
                    ns.print(`WARN ${stock.summary} SHORT BOUGHT ${ns.format.number(safeShares, 0)} shares`);
                }
            }
        }
    }
    ns.print("Stock value: " + formatMoney(ns, overallValue));

    // send stock market manipulation orders to hack manager
    var growStockPort = ns.getPortHandle(1); // port 1 is grow
    var hackStockPort = ns.getPortHandle(2); // port 2 is hack
    if (growStockPort.empty() && hackStockPort.empty()) {
        // only write to ports if empty
        for (const sym of longStocks) {
            //ns.print("INFO grow " + sym);
            const server = getSymServer(sym);
            if (server) growStockPort.write(server);
        }
        for (const sym of shortStocks) {
            //ns.print("INFO hack " + sym);
            const server = getSymServer(sym);
            if (server) hackStockPort.write(server);
        }
    }
}

export function getAllStocks(ns, commission = ns.stock.getConstants().StockMarketCommission) {
    // make a lookup table of all stocks and all their properties
    const stockSymbols = ns.stock.getSymbols();
    const stocks = [];
    for (const sym of stockSymbols) {

        const pos = ns.stock.getPosition(sym);
        const stock = {
            sym: sym,
            longShares: pos[0],
            longPrice: pos[1],
            shortShares: pos[2],
            shortPrice: pos[3],
            forecast: ns.stock.getForecast(sym),
            volatility: ns.stock.getVolatility(sym),
            askPrice: ns.stock.getAskPrice(sym),
            bidPrice: ns.stock.getBidPrice(sym),
            maxShares: ns.stock.getMaxShares(sym),
        };

        const longProfit = stock.longShares > 0
            ? stock.longShares * (stock.bidPrice - stock.longPrice) - 2 * commission
            : 0;
        const shortProfit = stock.shortShares > 0
            ? stock.shortShares * (stock.shortPrice - stock.askPrice) - 2 * commission
            : 0;
        stock.profit = longProfit + shortProfit;
        stock.cost = (stock.longShares * stock.longPrice) + (stock.shortShares * stock.shortPrice)

        // profit potential as chance for profit * effect of profit
        var profitChance = 2 * Math.abs(stock.forecast - 0.5);
        var profitPotential = profitChance * (stock.volatility);
        stock.profitPotential = profitPotential;

        stock.summary = `${stock.sym}: ${stock.forecast.toFixed(3)} ± ${stock.volatility.toFixed(3)}`;
        stocks.push(stock);
    }
    return stocks;
}

function getSymServer(sym) {
    const symServer = {
        "WDS": "",
        "ECP": "ecorp",
        "MGCP": "megacorp",
        "BLD": "blade",
        "CLRK": "clarkinc",
        "OMTK": "omnitek",
        "FSIG": "4sigma",
        "KGI": "kuai-gong",
        "DCOMM": "defcomm",
        "VITA": "vitalife",
        "ICRS": "icarus",
        "UNV": "univ-energy",
        "AERO": "aerocorp",
        "SLRS": "solaris",
        "GPH": "global-pharm",
        "NVMD": "nova-med",
        "LXO": "lexo-corp",
        "RHOC": "rho-construction",
        "APHE": "alpha-ent",
        "SYSC": "syscore",
        "CTK": "comptek",
        "NTLK": "netlink",
        "OMGA": "omega-net",
        "JGN": "joesguns",
        "SGC": "sigma-cosmetics",
        "CTYS": "catalyst",
        "MDYN": "microdyne",
        "TITN": "titan-labs",
        "FLCM": "fulcrumtech",
        "STM": "stormtech",
        "HLS": "helios",
        "OMN": "omnia",
        "FNS": "foodnstuff"
    }

    return symServer[sym];

}

function formatMoney(ns, value) {
    return `$${ns.format.number(value, 1)}`;
}
