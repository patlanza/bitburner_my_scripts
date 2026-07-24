/** @param {NS} ns **/
export async function main(ns) {
    const doc = document;

    // This does not work
    //const doc = eval("ns.bypass(document);");

    // Hook into game's overview
    const hook0 = doc.getElementById('overview-extra-hook-0');
    const hook1 = doc.getElementById('overview-extra-hook-1');

    while (true) {
        try {
            const headers = []
            const values = [];

            let hacknetTotalProduction = 0;
            let hacknetTotalProfit = 0;

            // Calculate total hacknet income & profit
            for (let index = 0; index <= ns.hacknet.numNodes() - 1; index++) {
                hacknetTotalProduction += ns.hacknet.getNodeStats(index).production;
                hacknetTotalProfit += ns.hacknet.getNodeStats(index).totalProduction;

                //ns.tprint("production for " + index + " " + ns.hacknet.getNodeStats(index).production.toPrecision(5));
            }

            headers.push("Hacknet Income: ");
            values.push("$" + ns.format.number(hacknetTotalProduction, 1) + "/s");

            headers.push("Hacknet Profit: ");
            values.push("$" + ns.format.number(hacknetTotalProfit, 1));

            const stockMarketValue = getStockMarketValue(ns);
            headers.push("Stock Market: ");
            values.push(
                stockMarketValue === null
                    ? "Sin acceso TIX"
                    : "$" + ns.format.number(stockMarketValue, 1),
            );

            headers.push("Script Income: ");
            values.push("$" + ns.format.number(ns.getTotalScriptIncome()[0], 1) + "/s");

            headers.push("Script Experience: ");
            values.push(ns.format.number(ns.getTotalScriptExpGain(), 2) + "/s");

            headers.push("Share Power: ");
            values.push(ns.format.percent(ns.getSharePower(), 2));

            headers.push("Karma: ");
            values.push(ns.format.number(ns.heart.break(), 1));

            headers.push("People Killed: ");
            values.push(ns.getPlayer().numPeopleKilled);

            headers.push("City: ");
            values.push(ns.getPlayer().city);

            headers.push("Location: ");
            values.push(ns.getPlayer().location.substring(0, 10));

            headers.push("Local Time: ");
            values.push(new Date().toLocaleTimeString());

            hook0.innerText = headers.join(" \n");
            hook1.innerText = values.join("\n");

        } catch (error) {
            ns.print("ERROR- Update Skipped: " + String(error));
        }

        await ns.sleep(1000);
    }
}

/** @param {NS} ns */
function getStockMarketValue(ns) {
    if (!ns.stock.hasTixApiAccess()) return null;

    const commission = ns.stock.getConstants().StockMarketCommission;
    let value = 0;
    for (const symbol of ns.stock.getSymbols()) {
        const [longShares, , shortShares, shortPrice] = ns.stock.getPosition(symbol);
        if (longShares > 0) {
            value += longShares * ns.stock.getBidPrice(symbol) - commission;
        }
        if (shortShares > 0) {
            value += shortShares * (shortPrice * 2 - ns.stock.getAskPrice(symbol)) - commission;
        }
    }
    return value;
}
