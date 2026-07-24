// Trader adaptativo compatible con Bitburner v3.0.1.
// Funciona con 4S exacto o, si no está disponible, estima la tendencia
// mediante un historial móvil de precios.

const EMPTY_SIGNAL = "EMPTY";
const GROW_STOCK_PORT = 1;
const HACK_STOCK_PORT = 2;

const FLAGS = [
    ["cash-reserve", 1e9],
    ["invest-fraction", 0.8],
    ["max-position-fraction", 0.25],
    ["buy-forecast", 0],
    ["sell-forecast", 0],
    ["history", 30],
    ["min-samples", 15],
    ["expected-hold-ticks", 10],
    ["edge-buffer", 1.2],
    ["short", false],
    ["manipulate", true],
    ["help", false],
];

const STOCK_SERVERS = Object.freeze({
    WDS: "",
    ECP: "ecorp",
    MGCP: "megacorp",
    BLD: "blade",
    CLRK: "clarkinc",
    OMTK: "omnitek",
    FSIG: "4sigma",
    KGI: "kuai-gong",
    DCOMM: "defcomm",
    VITA: "vitalife",
    ICRS: "icarus",
    UNV: "univ-energy",
    AERO: "aerocorp",
    SLRS: "solaris",
    GPH: "global-pharm",
    NVMD: "nova-med",
    LXO: "lexo-corp",
    RHOC: "rho-construction",
    APHE: "alpha-ent",
    SYSC: "syscore",
    CTK: "comptek",
    NTLK: "netlink",
    OMGA: "omega-net",
    JGN: "joesguns",
    SGC: "sigma-cosmetics",
    CTYS: "catalyst",
    MDYN: "microdyne",
    TITN: "titan-labs",
    FLCM: "fulcrumtech",
    STM: "stormtech",
    HLS: "helios",
    OMN: "omnia",
    FNS: "foodnstuff",
});

/** @param {AutocompleteData} data */
export function autocomplete(data, _args) {
    data.flags(FLAGS);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    const options = ns.flags(FLAGS);
    if (options.help) {
        printHelp(ns);
        return;
    }
    if (!validateOptions(ns, options)) return;

    ns.disableLog("ALL");
    const constants = ns.stock.getConstants();
    if (!ns.stock.hasTixApiAccess()) {
        ns.tprint(
            `ERROR: falta TIX API Access. Coste: ${formatMoney(ns, constants.TixApiCost)}.`,
        );
        return;
    }

    const has4S = ns.stock.has4SDataTixApi();
    const state = {
        has4S,
        symbols: ns.stock.getSymbols(),
        previousPrices: new Map(),
        returns: new Map(),
        shortEnabled: Boolean(options.short),
        warmupLoggedAt: -1,
    };

    options.buyForecast = Number(options["buy-forecast"]) > 0
        ? Number(options["buy-forecast"])
        : has4S ? 0.55 : 0.62;
    options.sellForecast = Number(options["sell-forecast"]) > 0
        ? Number(options["sell-forecast"])
        : has4S ? 0.5 : 0.52;
    if (options.sellForecast >= options.buyForecast) {
        ns.tprint(
            "ERROR: el umbral de venta debe ser menor que el de compra " +
            "(revisa --sell-forecast y --buy-forecast).",
        );
        return;
    }

    if (options.manipulate) {
        ns.atExit(() => clearStockSignals(ns));
    } else {
        clearStockSignals(ns);
    }

    log(
        ns,
        has4S
            ? `MODO 4S: forecast y volatilidad exactos; entrada ${formatPercent(options.buyForecast)}.`
            : `MODO ESTIMADO: ${options.history} ticks de histórico; ` +
              `entrada ${formatPercent(options.buyForecast)} tras ${options["min-samples"]} muestras.`,
    );
    log(
        ns,
        `RIESGO: reserva ${formatMoney(ns, options["cash-reserve"])}, ` +
        `inversión máxima ${formatPercent(options["invest-fraction"])}, ` +
        `${formatPercent(options["max-position-fraction"])} por símbolo.`,
    );

    while (true) {
        const stocks = getAllStocks(ns, state, options);
        const readyStocks = stocks.filter((stock) => stock.ready);

        if (readyStocks.length > 0) {
            tendStocks(ns, stocks, state, options, constants.StockMarketCommission);
        } else if (!has4S) {
            const samples = Math.max(0, ...stocks.map((stock) => stock.samples));
            if (samples !== state.warmupLoggedAt && (samples === 0 || samples % 5 === 0)) {
                log(
                    ns,
                    `CALENTAMIENTO: ${samples}/${options["min-samples"]} cambios de precio observados.`,
                );
                state.warmupLoggedAt = samples;
            }
        }

        if (options.manipulate) publishStockSignals(ns, state.symbols);
        await ns.stock.nextUpdate();
    }
}

/**
 * Lee todas las acciones y actualiza el estimador si no existe 4S.
 * @param {NS} ns
 * @param {{has4S:boolean,symbols:string[],previousPrices:Map<string,number>,returns:Map<string,number[]>}} state
 * @param {Record<string,any>} options
 */
export function getAllStocks(ns, state, options) {
    return state.symbols.map((symbol) => {
        const [longShares, longPrice, shortShares, shortPrice] = ns.stock.getPosition(symbol);
        const askPrice = ns.stock.getAskPrice(symbol);
        const bidPrice = ns.stock.getBidPrice(symbol);
        const price = (askPrice + bidPrice) / 2;
        const spread = Math.max(0, askPrice - bidPrice);
        const spreadFraction = price > 0 ? spread / price : Infinity;

        let forecast;
        let expectedMove;
        let volatility;
        let samples = Infinity;
        let ready = true;

        if (state.has4S) {
            forecast = ns.stock.getForecast(symbol);
            volatility = ns.stock.getVolatility(symbol);
            expectedMove = volatility / 2;
        } else {
            const history = state.returns.get(symbol) ?? [];
            const previousPrice = state.previousPrices.get(symbol);
            if (Number.isFinite(previousPrice) && previousPrice > 0 && price > 0) {
                history.push(price / previousPrice - 1);
                while (history.length > options.history) history.shift();
            }
            state.previousPrices.set(symbol, price);
            state.returns.set(symbol, history);

            samples = history.length;
            const positive = history.filter((change) => change > 1e-12).length;
            const flat = history.filter((change) => Math.abs(change) <= 1e-12).length;
            // Prior beta(1,1): reduce señales extremas con historiales pequeños.
            forecast = (positive + flat * 0.5 + 1) / (samples + 2);
            expectedMove = samples > 0
                ? history.reduce((sum, change) => sum + Math.abs(change), 0) / samples
                : 0;
            volatility = expectedMove * 2;
            ready = samples >= options["min-samples"];
        }

        const edgePerTick = Math.abs(2 * forecast - 1) * expectedMove;
        return {
            sym: symbol,
            server: getSymServer(symbol),
            longShares,
            longPrice,
            shortShares,
            shortPrice,
            forecast,
            volatility,
            expectedMove,
            edgePerTick,
            askPrice,
            bidPrice,
            price,
            spread,
            spreadFraction,
            maxShares: ns.stock.getMaxShares(symbol),
            samples,
            ready,
        };
    });
}

/**
 * Vende primero, recalcula el efectivo y compra las mejores oportunidades
 * cuyo rendimiento esperado cubra spread y comisiones.
 * @param {NS} ns
 * @param {ReturnType<getAllStocks>} stocks
 * @param {{shortEnabled:boolean}} state
 * @param {Record<string,any>} options
 * @param {number} commission
 */
function tendStocks(ns, stocks, state, options, commission) {
    let trades = 0;

    for (const stock of stocks) {
        if (!stock.ready) continue;

        if (stock.longShares > 0 && stock.forecast <= options.sellForecast) {
            const gain = ns.stock.getSaleGain(stock.sym, stock.longShares, "L");
            const economicProfit = gain - stock.longShares * stock.longPrice - commission;
            const salePrice = ns.stock.sellStock(stock.sym, stock.longShares);
            if (salePrice > 0) {
                log(
                    ns,
                    `VENTA LONG ${stock.sym}: ${formatMoney(ns, gain)} recuperados, ` +
                    `${signedMoney(ns, economicProfit)} estimado.`,
                );
                stock.longShares = 0;
                stock.longPrice = 0;
                trades++;
            } else {
                log(ns, `ERROR: no se pudo vender la posición LONG de ${stock.sym}.`);
            }
        }

        const shortExitForecast = 1 - options.sellForecast;
        if (stock.shortShares > 0 && stock.forecast >= shortExitForecast) {
            const gain = ns.stock.getSaleGain(stock.sym, stock.shortShares, "S");
            const economicProfit = gain - stock.shortShares * stock.shortPrice - commission;
            let salePrice = 0;
            try {
                salePrice = ns.stock.sellShort(stock.sym, stock.shortShares);
            } catch (error) {
                log(ns, `ERROR SHORT ${stock.sym}: ${String(error)}`);
            }
            if (salePrice > 0) {
                log(
                    ns,
                    `CIERRE SHORT ${stock.sym}: ${formatMoney(ns, gain)} recuperados, ` +
                    `${signedMoney(ns, economicProfit)} estimado.`,
                );
                stock.shortShares = 0;
                stock.shortPrice = 0;
                trades++;
            }
        }
    }

    const cash = ns.getServerMoneyAvailable("home");
    const portfolioValue = getPortfolioValue(ns, stocks);
    const totalCapital = Math.max(0, cash + portfolioValue);
    let investmentBudget = Math.max(
        0,
        Math.min(
            cash - options["cash-reserve"],
            totalCapital * options["invest-fraction"] - portfolioValue,
        ),
    );
    const maxPositionValue = totalCapital * options["max-position-fraction"];

    const candidates = [];
    for (const stock of stocks) {
        if (!stock.ready || stock.edgePerTick <= 0) continue;
        const currentExposure =
            stock.longShares * stock.askPrice + stock.shortShares * stock.bidPrice;

        if (stock.forecast >= options.buyForecast && stock.shortShares === 0) {
            candidates.push({
                stock,
                position: "L",
                score: stock.edgePerTick - stock.spreadFraction / options["expected-hold-ticks"],
                currentExposure,
            });
        }
        if (
            state.shortEnabled &&
            stock.forecast <= 1 - options.buyForecast &&
            stock.longShares === 0
        ) {
            candidates.push({
                stock,
                position: "S",
                score: stock.edgePerTick - stock.spreadFraction / options["expected-hold-ticks"],
                currentExposure,
            });
        }
    }
    candidates.sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
        if (investmentBudget <= commission) break;
        const stock = candidate.stock;
        const freePositionValue = Math.max(0, maxPositionValue - candidate.currentExposure);
        const currentCash = ns.getServerMoneyAvailable("home");
        const budget = Math.min(
            investmentBudget,
            freePositionValue,
            Math.max(0, currentCash - options["cash-reserve"]),
        );
        if (budget <= commission) continue;

        const availableShares = Math.max(
            0,
            stock.maxShares - stock.longShares - stock.shortShares,
        );
        let shares = 0;
        try {
            shares = getAffordableShares(
                ns,
                stock.sym,
                candidate.position,
                budget,
                availableShares,
            );
        } catch (error) {
            if (candidate.position === "S") {
                state.shortEnabled = false;
                log(
                    ns,
                    `AVISO: cortos desactivados; se requiere BN8 o Source-File 8.2. ${String(error)}`,
                );
            } else {
                log(ns, `ERROR COMPRA ${stock.sym}: ${String(error)}`);
            }
            continue;
        }
        if (shares < 1) continue;

        const expectedGrossGain =
            shares * stock.price * stock.edgePerTick * options["expected-hold-ticks"];
        const roundTripCost = shares * stock.spread + 2 * commission;
        if (expectedGrossGain < roundTripCost * options["edge-buffer"]) continue;

        let purchaseCost = 0;
        let purchasePrice = 0;
        try {
            purchaseCost = ns.stock.getPurchaseCost(
                stock.sym,
                shares,
                candidate.position,
            );
            purchasePrice = candidate.position === "L"
                ? ns.stock.buyStock(stock.sym, shares)
                : ns.stock.buyShort(stock.sym, shares);
        } catch (error) {
            if (candidate.position === "S") {
                state.shortEnabled = false;
                log(
                    ns,
                    `AVISO: cortos desactivados; se requiere BN8 o Source-File 8.2. ${String(error)}`,
                );
                continue;
            }
            log(ns, `ERROR COMPRA ${stock.sym}: ${String(error)}`);
        }

        if (purchasePrice <= 0) continue;
        investmentBudget = Math.max(0, investmentBudget - purchaseCost);
        if (candidate.position === "L") stock.longShares += shares;
        else stock.shortShares += shares;
        trades++;
        log(
            ns,
            `COMPRA ${candidate.position === "L" ? "LONG" : "SHORT"} ${stock.sym}: ` +
            `${ns.format.number(shares, 0)} acciones por ${formatMoney(ns, purchaseCost)}, ` +
            `forecast ${formatPercent(stock.forecast)}, edge ${formatPercent(stock.edgePerTick)}/tick.`,
        );
    }

    const finalStocks = refreshPositions(ns, stocks);
    const finalValue = getPortfolioValue(ns, finalStocks);
    const positions = finalStocks.filter(
        (stock) => stock.longShares > 0 || stock.shortShares > 0,
    ).length;
    log(
        ns,
        `CARTERA: ${formatMoney(ns, finalValue)} en ${positions} posición(es); ` +
        `efectivo ${formatMoney(ns, ns.getServerMoneyAvailable("home"))}` +
        (trades > 0 ? `; ${trades} operación(es).` : "."),
    );
}

/** @param {NS} ns */
function getAffordableShares(ns, symbol, position, budget, maximum) {
    let low = 0;
    let high = Math.max(0, Math.floor(maximum));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const cost = ns.stock.getPurchaseCost(symbol, middle, position);
        if (Number.isFinite(cost) && cost <= budget) low = middle;
        else high = middle - 1;
    }
    return low;
}

/** @param {NS} ns @param {ReturnType<getAllStocks>} stocks */
function refreshPositions(ns, stocks) {
    for (const stock of stocks) {
        const [longShares, longPrice, shortShares, shortPrice] =
            ns.stock.getPosition(stock.sym);
        stock.longShares = longShares;
        stock.longPrice = longPrice;
        stock.shortShares = shortShares;
        stock.shortPrice = shortPrice;
    }
    return stocks;
}

/** @param {NS} ns @param {ReturnType<getAllStocks>} stocks */
function getPortfolioValue(ns, stocks) {
    let value = 0;
    for (const stock of stocks) {
        if (stock.longShares > 0) {
            value += ns.stock.getSaleGain(stock.sym, stock.longShares, "L");
        }
        if (stock.shortShares > 0) {
            value += ns.stock.getSaleGain(stock.sym, stock.shortShares, "S");
        }
    }
    return value;
}

/**
 * Publica un estado completo en cada tick. EMPTY es importante: permite que
 * el coordinador olvide una señal que ya no corresponde a una posición.
 * @param {NS} ns
 * @param {string[]} symbols
 */
function publishStockSignals(ns, symbols) {
    const growTargets = new Set();
    const hackTargets = new Set();
    for (const symbol of symbols) {
        const [longShares, , shortShares] = ns.stock.getPosition(symbol);
        const server = getSymServer(symbol);
        if (!server) continue;
        if (longShares > 0) growTargets.add(server);
        if (shortShares > 0) hackTargets.add(server);
    }
    replacePort(ns.getPortHandle(GROW_STOCK_PORT), growTargets);
    replacePort(ns.getPortHandle(HACK_STOCK_PORT), hackTargets);
}

/** @param {NetscriptPort} port @param {Set<string>} values */
function replacePort(port, values) {
    port.clear();
    if (values.size === 0) {
        port.write(EMPTY_SIGNAL);
        return;
    }
    for (const value of values) port.write(value);
}

/** @param {NS} ns */
function clearStockSignals(ns) {
    replacePort(ns.getPortHandle(GROW_STOCK_PORT), new Set());
    replacePort(ns.getPortHandle(HACK_STOCK_PORT), new Set());
}

function getSymServer(symbol) {
    return STOCK_SERVERS[symbol] ?? "";
}

/** @param {NS} ns */
function validateOptions(ns, options) {
    const rules = [
        ["cash-reserve", 0, Infinity],
        ["invest-fraction", 0, 1],
        ["max-position-fraction", 0.01, 1],
        ["buy-forecast", 0, 0.999999],
        ["sell-forecast", 0, 0.999999],
        ["history", 5, 500],
        ["min-samples", 3, 500],
        ["expected-hold-ticks", 1, 1000],
        ["edge-buffer", 0, 100],
    ];
    for (const [name, minimum, maximum] of rules) {
        const value = Number(options[name]);
        if (!Number.isFinite(value) || value < minimum || value > maximum) {
            ns.tprint(`ERROR: --${name} debe estar entre ${minimum} y ${maximum}.`);
            return false;
        }
        options[name] = value;
    }
    options.history = Math.floor(options.history);
    options["min-samples"] = Math.floor(options["min-samples"]);
    if (options["min-samples"] > options.history) {
        ns.tprint("ERROR: --min-samples no puede superar --history.");
        return false;
    }
    if (
        options["buy-forecast"] > 0 &&
        options["buy-forecast"] <= 0.5
    ) {
        ns.tprint("ERROR: --buy-forecast debe ser 0 (automático) o mayor que 0.5.");
        return false;
    }
    if (
        options["buy-forecast"] > 0 &&
        options["sell-forecast"] > 0 &&
        options["sell-forecast"] >= options["buy-forecast"]
    ) {
        ns.tprint("ERROR: --sell-forecast debe ser menor que --buy-forecast.");
        return false;
    }
    return true;
}

/** @param {NS} ns */
function printHelp(ns) {
    ns.tprint(`Uso: run ${ns.getScriptName()} [opciones]`);
    ns.tprint("  --cash-reserve 1e9          Efectivo que nunca se invierte.");
    ns.tprint("  --invest-fraction 0.8       Fracción máxima del capital total invertida.");
    ns.tprint("  --max-position-fraction 0.25 Límite de capital por símbolo.");
    ns.tprint("  --buy-forecast 0            0 usa 0.55 con 4S o 0.62 estimado.");
    ns.tprint("  --sell-forecast 0           0 usa 0.50 con 4S o 0.52 estimado.");
    ns.tprint("  --history 30                Ventana del estimador sin 4S.");
    ns.tprint("  --min-samples 15            Muestras exigidas antes de operar sin 4S.");
    ns.tprint("  --expected-hold-ticks 10    Horizonte para cubrir spread/comisiones.");
    ns.tprint("  --edge-buffer 1.2           Margen exigido sobre costes de entrada/salida.");
    ns.tprint("  --short false               Activa cortos en BN8 o con Source-File 8.2.");
    ns.tprint("  --manipulate true           Coordina grow/hack bursátil mediante puertos.");
}

/** @param {NS} ns */
function log(ns, message) {
    const time = new Date().toLocaleTimeString();
    ns.print(`[${time}] ${message}`);
}

/** @param {NS} ns */
function formatMoney(ns, value) {
    return `$${ns.format.number(value, 2)}`;
}

/** @param {NS} ns */
function signedMoney(ns, value) {
    return `${value >= 0 ? "+" : "-"}${formatMoney(ns, Math.abs(value))}`;
}

function formatPercent(value) {
    return `${(value * 100).toFixed(2)}%`;
}
