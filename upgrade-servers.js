const HOME = "home";

const FLAGS = [
    ["min-ram", 8],
    ["budget-fraction", 0.5],
    ["reserve", 0],
    ["interval", 5000],
    ["prefix", "pserv-"],
    ["help", false],
];

/** @param {NS} ns */
export async function main(ns) {
    const options = ns.flags(FLAGS);

    if (options.help) {
        printHelp(ns);
        return;
    }

    if (ns.getHostname() !== HOME) {
        ns.tprint(`ERROR: ${ns.getScriptName()} debe ejecutarse desde home.`);
        return;
    }

    if (options["budget-fraction"] <= 0 || options["budget-fraction"] > 1) {
        ns.tprint("ERROR: --budget-fraction debe estar entre 0 y 1.");
        return;
    }

    const duplicate = ns.ps(HOME).find(
        (process) => process.filename === ns.getScriptName() && process.pid !== ns.pid,
    );
    if (duplicate) {
        ns.tprint(
            `ERROR: ${ns.getScriptName()} ya se ejecuta con PID ${duplicate.pid}.`,
        );
        return;
    }

    const ramLimit = ns.cloud.getRamLimit();
    const serverLimit = ns.cloud.getServerLimit();
    const minimumRam = normalizeRam(options["min-ram"], ramLimit);
    const interval = Math.max(200, Number(options.interval));
    const reserve = Math.max(0, Number(options.reserve));
    const prefix = String(options.prefix);

    ns.disableLog("ALL");
    log(ns, `RAM inicial por servidor: ${ns.format.ram(minimumRam)}.`);
    log(ns, `Límite: ${serverLimit} servidores de hasta ${ns.format.ram(ramLimit)}.`);

    while (true) {
        let servers = ns.cloud.getServerNames();

        if (
            servers.length >= serverLimit &&
            servers.every((host) => ns.getServerMaxRam(host) >= ramLimit)
        ) {
            log(ns, "Todos los Cloud servers están al máximo.");
            ns.tprint("Todos los Cloud servers están al máximo.");
            return;
        }

        const money = ns.getServerMoneyAvailable(HOME);
        let budget = Math.max(
            0,
            Math.min(money - reserve, money * options["budget-fraction"]),
        );
        let operations = 0;

        // Comprar todos los slots aporta capacidad y paralelismo antes de
        // concentrar el dinero en servidores individuales muy grandes.
        const purchaseCost = ns.cloud.getServerCost(minimumRam);
        while (servers.length < serverLimit && purchaseCost <= budget) {
            const hostname = nextHostname(prefix, servers, serverLimit);
            if (!hostname) {
                log(ns, `No se encontró un nombre libre con el prefijo "${prefix}".`);
                break;
            }

            const purchased = ns.cloud.purchaseServer(hostname, minimumRam);
            if (!purchased) {
                log(ns, `ERROR: no se pudo comprar ${hostname}.`);
                break;
            }

            budget -= purchaseCost;
            operations++;
            servers.push(purchased);
            log(
                ns,
                `COMPRA: ${purchased} con ${ns.format.ram(minimumRam)} por $${ns.format.number(purchaseCost, 2)}.`,
            );
        }

        // Mejora siempre el servidor más pequeño. Esto mantiene una flota
        // equilibrada y evita borrar servidores, archivos o procesos.
        while (servers.length > 0 && budget > 0) {
            servers.sort(
                (a, b) => ns.getServerMaxRam(a) - ns.getServerMaxRam(b),
            );

            const host = servers[0];
            const currentRam = ns.getServerMaxRam(host);
            if (currentRam >= ramLimit) break;

            const upgrade = largestAffordableUpgrade(
                ns,
                host,
                currentRam,
                ramLimit,
                budget,
            );
            if (!upgrade) break;

            if (!ns.cloud.upgradeServer(host, upgrade.ram)) {
                log(ns, `ERROR: no se pudo mejorar ${host}.`);
                break;
            }

            budget -= upgrade.cost;
            operations++;
            log(
                ns,
                `UPGRADE: ${host}, ${ns.format.ram(currentRam)} -> ` +
                `${ns.format.ram(upgrade.ram)} por $${ns.format.number(upgrade.cost, 2)}.`,
            );
        }

        if (operations === 0) {
            const status = getNextOperation(ns, servers, serverLimit, minimumRam, ramLimit);
            log(
                ns,
                `Esperando fondos. Próxima operación: ${status.description}; ` +
                `coste $${ns.format.number(status.cost, 2)}.`,
            );
        } else {
            log(ns, `Ciclo terminado: ${operations} operación(es).`);
        }

        await ns.sleep(interval);
    }
}

/** @param {number} value @param {number} limit */
function normalizeRam(value, limit) {
    const numericValue = Math.max(2, Math.min(limit, Number(value) || 2));
    return 2 ** Math.floor(Math.log2(numericValue));
}

/**
 * @param {NS} ns
 * @param {string} host
 * @param {number} currentRam
 * @param {number} ramLimit
 * @param {number} budget
 */
function largestAffordableUpgrade(ns, host, currentRam, ramLimit, budget) {
    let best = null;

    for (let ram = currentRam * 2; ram <= ramLimit; ram *= 2) {
        const cost = ns.cloud.getServerUpgradeCost(host, ram);
        if (!Number.isFinite(cost) || cost > budget) break;
        best = { ram, cost };
    }

    return best;
}

/**
 * @param {string} prefix
 * @param {string[]} servers
 * @param {number} serverLimit
 */
function nextHostname(prefix, servers, serverLimit) {
    const used = new Set(servers);
    for (let index = 0; index < serverLimit * 2; index++) {
        const hostname = `${prefix}${index}`;
        if (!used.has(hostname)) return hostname;
    }
    return "";
}

/**
 * @param {NS} ns
 * @param {string[]} servers
 * @param {number} serverLimit
 * @param {number} minimumRam
 * @param {number} ramLimit
 */
function getNextOperation(ns, servers, serverLimit, minimumRam, ramLimit) {
    if (servers.length < serverLimit) {
        return {
            description: `comprar otro servidor de ${ns.format.ram(minimumRam)}`,
            cost: ns.cloud.getServerCost(minimumRam),
        };
    }

    const host = [...servers].sort(
        (a, b) => ns.getServerMaxRam(a) - ns.getServerMaxRam(b),
    )[0];
    const currentRam = ns.getServerMaxRam(host);
    const nextRam = Math.min(ramLimit, currentRam * 2);
    return {
        description: `mejorar ${host} a ${ns.format.ram(nextRam)}`,
        cost: ns.cloud.getServerUpgradeCost(host, nextRam),
    };
}

/** @param {NS} ns @param {string} message */
function log(ns, message) {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
    ns.print(`[${time}] ${message}`);
}

/** @param {NS} ns */
function printHelp(ns) {
    ns.tprint(`Uso: run ${ns.getScriptName()} [opciones]`);
    ns.tprint("  --min-ram 8             RAM de cada servidor nuevo, potencia de 2.");
    ns.tprint("  --budget-fraction 0.5   Fracción máxima del dinero usada por ciclo.");
    ns.tprint("  --reserve 0             Dinero que nunca se gastará.");
    ns.tprint("  --interval 5000         Tiempo entre ciclos, en milisegundos.");
    ns.tprint('  --prefix "pserv-"       Prefijo para servidores nuevos.');
}

export function autocomplete(data, _) {
    data.flags(FLAGS);
    return [];
}
